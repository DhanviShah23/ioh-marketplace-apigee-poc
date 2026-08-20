import Fastify from "fastify";
import type pg from "pg";
import { createHash } from "node:crypto";
import type { Config } from "./config.js";
import type { ApigeeClient, OasDoc } from "./apigee.js";
import { mirrorAndVerify, writeEventLog } from "./gcs.js";

export function buildServer(pool: pg.Pool, apigee: ApigeeClient, config: Config) {
  const app = Fastify({ logger: true });

  app.get("/health", async () => ({ status: "ok" }));

  app.post("/api-asset-versions", async (req, reply) => {
    const body = req.body as {
      api_id: string;
      namespace: string;
      origin: "IOH" | "VENDOR";
      owning_domain?: string;
      vendor_org_id?: string;
      major_version: number;
      oas_semantic_version: string;
      repo: string;
      path: string;
      commit_sha: string;
      checksum_sha256: string;
      gcs_spec_uri?: string;
      governance_evidence_uri?: string;
      created_by: string;
      spec: OasDoc;
      spec_raw: string;
    };

    const required = ["api_id", "namespace", "origin", "major_version", "oas_semantic_version", "repo", "path", "commit_sha", "checksum_sha256", "created_by", "spec", "spec_raw"] as const;
    for (const field of required) {
      if (body[field] === undefined || body[field] === null) {
        return reply.code(400).send({ error: `missing required field: ${field}` });
      }
    }

    await pool.query(
      `INSERT INTO api (api_id, namespace, origin, owning_domain, vendor_org_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (api_id) DO NOTHING`,
      [body.api_id, body.namespace, body.origin, body.owning_domain ?? null, body.vendor_org_id ?? null, body.created_by]
    );

    const predecessor = await pool.query<{ id: number }>(
      `SELECT id FROM api_asset_version WHERE api_id = $1 AND major_version = $2 ORDER BY id DESC LIMIT 1`,
      [body.api_id, body.major_version]
    );
    const predecessorId = predecessor.rows[0]?.id ?? null;

    const inserted = await pool.query<{ id: number }>(
      `INSERT INTO api_asset_version
         (api_id, major_version, oas_semantic_version, repo, path, commit_sha, checksum_sha256,
          gcs_spec_uri, governance_evidence_uri, predecessor_version_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'REGISTERING')
       ON CONFLICT (api_id, commit_sha) DO UPDATE SET status = api_asset_version.status
       RETURNING id`,
      [
        body.api_id,
        body.major_version,
        body.oas_semantic_version,
        body.repo,
        body.path,
        body.commit_sha,
        body.checksum_sha256,
        body.gcs_spec_uri ?? null,
        body.governance_evidence_uri ?? null,
        predecessorId,
      ]
    );
    const versionId = inserted.rows[0].id;

    const nsPrefix = body.origin === "VENDOR" ? `vendor/${body.vendor_org_id}/apis` : "ioh/apis";
    const objectPrefix = `${nsPrefix}/${body.api_id}/v${body.major_version}/${body.commit_sha}`;
    const eventLogPath = `${nsPrefix}/${body.api_id}/v${body.major_version}/${body.commit_sha}.json`;

    // Defensive: verify what we received matches what CI hashed from Git,
    // before ever touching GCS or Apigee.
    const receivedChecksum = createHash("sha256").update(body.spec_raw, "utf8").digest("hex");
    if (receivedChecksum !== body.checksum_sha256) {
      await pool.query(`UPDATE api_asset_version SET status = 'FAILED' WHERE id = $1`, [versionId]);
      return reply.code(400).send({
        api_asset_version_id: versionId,
        status: "FAILED",
        error: `checksum mismatch between request and received spec_raw content (expected ${body.checksum_sha256}, got ${receivedChecksum})`,
      });
    }

    // DESIGN.md §4: mirror to GCS, then independently re-download and
    // re-hash — match proceeds to packaging, mismatch fails outright and
    // is never exposed for packaging (no Apigee proxy is created either).
    let mirror;
    try {
      mirror = await mirrorAndVerify(config.gcsAssetsBucket, `${objectPrefix}/openapi.yaml`, Buffer.from(body.spec_raw, "utf8"), body.checksum_sha256);
    } catch (err) {
      app.log.error(err);
      await pool.query(`UPDATE api_asset_version SET status = 'FAILED' WHERE id = $1`, [versionId]);
      return reply.code(502).send({ api_asset_version_id: versionId, status: "FAILED", error: err instanceof Error ? err.message : String(err) });
    }

    if (!mirror.verified) {
      await pool.query(`UPDATE api_asset_version SET status = 'FAILED', gcs_spec_uri = $2 WHERE id = $1`, [versionId, mirror.gcsUri]);
      await writeEventLog(config.gcsLogsBucket, eventLogPath, {
        event_type: "ApiAssetVersionChecksumMismatch",
        api_id: body.api_id,
        namespace: body.namespace,
        major_version: body.major_version,
        commit_sha: body.commit_sha,
        oas_semantic_version: body.oas_semantic_version,
        actor: body.created_by,
        checksum_expected: body.checksum_sha256,
        checksum_actual: mirror.actualSha256,
        outcome: "FAILED",
        timestamp: new Date().toISOString(),
      });
      return reply.code(502).send({
        api_asset_version_id: versionId,
        status: "FAILED",
        error: `GCS checksum verification failed: expected ${body.checksum_sha256}, got ${mirror.actualSha256} after round-trip`,
      });
    }

    await pool.query(`UPDATE api_asset_version SET gcs_spec_uri = $2 WHERE id = $1`, [versionId, mirror.gcsUri]);

    const proxyName = `${body.api_id}-v${body.major_version}`;
    const basePath = `/${body.api_id}/v${body.major_version}`;
    const targetUrl = body.spec.servers?.[0]?.url ?? "https://httpbin.org/anything";

    try {
      const deployed = await apigee.createAndDeployProxy({
        proxyName,
        basePath,
        targetUrl,
        displayName: body.spec.info?.title ?? proxyName,
        description: body.spec.info?.description ?? "",
      });

      await pool.query(
        `INSERT INTO apigee_proxy (api_asset_version_id, apigee_org, apigee_env, proxy_name, revision, deployed_at, status)
         VALUES ($1,$2,$3,$4,$5, now(), $6)`,
        [versionId, config.apigeeOrg, config.apigeeEnv, deployed.proxyName, deployed.revision, deployed.status]
      );
      await pool.query(`UPDATE api_asset_version SET status = 'AVAILABLE_FOR_PACKAGING' WHERE id = $1`, [versionId]);

      const eventLogUri = await writeEventLog(config.gcsLogsBucket, eventLogPath, {
        event_type: "ApiAssetVersionRegistered",
        api_id: body.api_id,
        namespace: body.namespace,
        major_version: body.major_version,
        commit_sha: body.commit_sha,
        oas_semantic_version: body.oas_semantic_version,
        actor: body.created_by,
        checksum: body.checksum_sha256,
        gcs_spec_uri: mirror.gcsUri,
        apigee_proxy: deployed,
        outcome: "PASSED",
        timestamp: new Date().toISOString(),
      });
      await pool.query(`UPDATE api_asset_version SET governance_evidence_uri = $2 WHERE id = $1`, [versionId, eventLogUri]);

      return reply.code(201).send({
        api_asset_version_id: versionId,
        status: "AVAILABLE_FOR_PACKAGING",
        apigee_proxy: deployed,
        gcs_spec_uri: mirror.gcsUri,
        governance_evidence_uri: eventLogUri,
      });
    } catch (err) {
      app.log.error(err);
      await pool.query(`UPDATE api_asset_version SET status = 'FAILED' WHERE id = $1`, [versionId]);
      return reply.code(502).send({
        api_asset_version_id: versionId,
        status: "FAILED",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get("/api-asset-versions/:apiId", async (req) => {
    const { apiId } = req.params as { apiId: string };
    const versions = await pool.query(
      `SELECT v.*, p.proxy_name, p.revision, p.status AS proxy_status
       FROM api_asset_version v
       LEFT JOIN apigee_proxy p ON p.api_asset_version_id = v.id
       WHERE v.api_id = $1
       ORDER BY v.id DESC`,
      [apiId]
    );
    return { versions: versions.rows };
  });

  app.post("/apigee-products", async (req, reply) => {
    const body = req.body as {
      bundle_id: string;
      offer_version_id: number;
      tier_name: string;
      quota_limit: number;
      quota_interval: "DAY" | "MONTH";
      api_ids: string[];
    };

    const required = ["bundle_id", "offer_version_id", "tier_name", "quota_limit", "quota_interval", "api_ids"] as const;
    for (const field of required) {
      if (body[field] === undefined || body[field] === null) {
        return reply.code(400).send({ error: `missing required field: ${field}` });
      }
    }
    if (!Array.isArray(body.api_ids) || body.api_ids.length === 0) {
      return reply.code(400).send({ error: "api_ids must be a non-empty array" });
    }

    const proxyNames: string[] = [];
    const missing: string[] = [];
    for (const apiId of body.api_ids) {
      const row = await pool.query<{ proxy_name: string }>(
        `SELECT p.proxy_name
         FROM api_asset_version v
         JOIN apigee_proxy p ON p.api_asset_version_id = v.id
         WHERE v.api_id = $1 AND v.status = 'AVAILABLE_FOR_PACKAGING' AND p.status = 'DEPLOYED'
         ORDER BY v.id DESC LIMIT 1`,
        [apiId]
      );
      if (row.rows[0]) proxyNames.push(row.rows[0].proxy_name);
      else missing.push(apiId);
    }
    if (missing.length > 0) {
      return reply.code(409).send({ error: `no deployed proxy found for api_id(s): ${missing.join(", ")}` });
    }

    const productName = `ioh-marketplace-${body.bundle_id}-${body.tier_name}-product`
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-");

    const existing = await pool.query(`SELECT * FROM apigee_product WHERE apigee_product_name = $1`, [productName]);
    if (existing.rows[0]) {
      return reply.code(200).send({ apigee_product: existing.rows[0], idempotent: true });
    }

    try {
      const created = await apigee.createProduct({
        productName,
        displayName: `${body.tier_name} — bundle ${body.bundle_id}`,
        proxyNames,
        quotaLimit: body.quota_limit,
        quotaInterval: body.quota_interval,
        attributes: {
          bundle_id: body.bundle_id,
          offer_version_id: String(body.offer_version_id),
          tier_name: body.tier_name,
        },
      });

      const inserted = await pool.query(
        `INSERT INTO apigee_product
           (offer_version_ref, bundle_id_ref, apigee_org, apigee_product_name, quota_limit, quota_interval, proxy_names, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [body.offer_version_id, body.bundle_id, config.apigeeOrg, created.apigeeProductName, body.quota_limit, body.quota_interval, proxyNames, created.status]
      );

      return reply.code(201).send({ apigee_product: inserted.rows[0] });
    } catch (err) {
      app.log.error(err);
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/apigee-products/:id/attach-app", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { developer_email: string; app_name: string };
    if (!body.developer_email || !body.app_name) {
      return reply.code(400).send({ error: "developer_email and app_name are required" });
    }

    const product = await pool.query(`SELECT * FROM apigee_product WHERE id = $1`, [id]);
    if (!product.rows[0]) return reply.code(404).send({ error: `apigee_product ${id} not found` });

    try {
      const attached = await apigee.attachAppToProduct({
        developerEmail: body.developer_email,
        appName: body.app_name,
        productName: product.rows[0].apigee_product_name,
      });
      return reply.code(200).send({ attached });
    } catch (err) {
      app.log.error(err);
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return app;
}
