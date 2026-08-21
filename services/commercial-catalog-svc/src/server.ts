import Fastify from "fastify";
import type pg from "pg";
import type { Config } from "./config.js";
import { createApigeeProduct, attachAppToProduct, authHeaders } from "./governanceClient.js";

export function buildServer(pool: pg.Pool, config: Config) {
  const app = Fastify({ logger: true });

  app.get("/health", async () => ({ status: "ok" }));

  // Bundles with their latest approval status and tiers. ?status=PUBLISHED
  // for the catalog, ?status=PENDING_APPROVAL for the approvals queue.
  app.get("/bundles", async (req) => {
    const { status } = req.query as { status?: string };
    const latestPerBundle = await pool.query(`
      SELECT DISTINCT ON (b.bundle_id) b.*, pv.id AS product_version_id, pv.version_number, pv.published_at
      FROM bundle b
      JOIN product_version pv ON pv.bundle_id = b.bundle_id
      ORDER BY b.bundle_id, pv.version_number DESC
    `);

    const withStatus = await Promise.all(
      latestPerBundle.rows.map(async (b) => {
        const approval = (await pool.query(
          `SELECT * FROM bundle_approval WHERE product_version_id = $1 ORDER BY id DESC LIMIT 1`,
          [b.product_version_id]
        )).rows[0];
        return { ...b, latest_status: approval?.status ?? null };
      })
    );

    const filtered = status === "PUBLISHED"
      ? withStatus.filter((r) => r.published_at)
      : status
      ? withStatus.filter((r) => r.latest_status === status)
      : withStatus;

    const withTiers = await Promise.all(
      filtered.map(async (b) => {
        const tiers = await pool.query(`SELECT * FROM offer_version WHERE product_version_id = $1 ORDER BY id`, [b.product_version_id]);
        const apis = await pool.query(`SELECT api_id FROM bundle_asset WHERE bundle_id = $1`, [b.bundle_id]);
        return { ...b, tiers: tiers.rows, api_ids: apis.rows.map((r) => r.api_id) };
      })
    );
    return { bundles: withTiers };
  });

  app.get("/bundles/:bundleId", async (req, reply) => {
    const { bundleId } = req.params as { bundleId: string };
    const pv = await latestProductVersion(pool, bundleId);
    if (!pv) return reply.code(404).send({ error: "bundle not found" });
    const bundle = (await pool.query(`SELECT * FROM bundle WHERE bundle_id = $1`, [bundleId])).rows[0];
    const tiers = (await pool.query(`SELECT * FROM offer_version WHERE product_version_id = $1 ORDER BY id`, [pv.id])).rows;
    const apis = (await pool.query(`SELECT api_id FROM bundle_asset WHERE bundle_id = $1`, [bundleId])).rows.map((r) => r.api_id);
    const approvals = (await pool.query(`SELECT * FROM bundle_approval WHERE product_version_id = $1 ORDER BY id`, [pv.id])).rows;
    return { bundle, product_version: pv, tiers, api_ids: apis, approvals };
  });

  // Registers the real Apigee developer/app you created manually for this
  // org_id/app_id, so future subscriptions attach products to that exact
  // app rather than a synthesized one. Call this once per app.
  app.post("/subscriber-apps", async (req, reply) => {
    const body = req.body as { app_id: string; org_id: string; apigee_developer_email: string; apigee_app_name: string };
    if (!body.app_id || !body.org_id || !body.apigee_developer_email || !body.apigee_app_name) {
      return reply.code(400).send({ error: "app_id, org_id, apigee_developer_email, apigee_app_name are required" });
    }
    const inserted = await pool.query(
      `INSERT INTO subscriber_app (app_id, org_id, apigee_developer_email, apigee_app_name)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (app_id) DO UPDATE SET org_id=$2, apigee_developer_email=$3, apigee_app_name=$4
       RETURNING *`,
      [body.app_id, body.org_id, body.apigee_developer_email, body.apigee_app_name]
    );
    return reply.code(201).send({ subscriber_app: inserted.rows[0] });
  });

  // Local read-through cache of a governance-approved asset (DESIGN.md §8's
  // api_asset_ref). Upserts from api-governance-svc's registry on demand.
  app.post("/api-asset-refs/sync", async (req, reply) => {
    const { api_id } = req.body as { api_id: string };
    const res = await fetch(`${config.governanceSvcUrl}/api-asset-versions/${api_id}`, { headers: await authHeaders(config) });
    if (!res.ok) return reply.code(502).send({ error: "governance svc lookup failed" });
    const data = (await res.json()) as { versions: Array<Record<string, unknown>> };
    const latest = data.versions.find((v) => v.status === "AVAILABLE_FOR_PACKAGING");
    if (!latest) return reply.code(409).send({ error: `no AVAILABLE_FOR_PACKAGING version for ${api_id}` });

    await pool.query(
      `INSERT INTO api_asset_ref (api_id, major_version, api_asset_version_ref, display_name, status)
       VALUES ($1,$2,$3,$4,'AVAILABLE_FOR_PACKAGING')
       ON CONFLICT (api_id) DO UPDATE SET major_version=$2, api_asset_version_ref=$3, status='AVAILABLE_FOR_PACKAGING'`,
      [api_id, latest.major_version, latest.id, api_id]
    );
    return { synced: api_id };
  });

  app.post("/bundles", async (req, reply) => {
    const body = req.body as { name: string; visibility?: "PUBLIC" | "RESTRICTED"; created_by: string; api_ids: string[] };
    if (!body.name || !body.created_by || !Array.isArray(body.api_ids) || body.api_ids.length === 0) {
      return reply.code(400).send({ error: "name, created_by, and a non-empty api_ids are required" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const bundle = await client.query(
        `INSERT INTO bundle (name, visibility, created_by) VALUES ($1,$2,$3) RETURNING *`,
        [body.name, body.visibility ?? "RESTRICTED", body.created_by]
      );
      const bundleId = bundle.rows[0].bundle_id;

      for (const apiId of body.api_ids) {
        const ref = await client.query(`SELECT 1 FROM api_asset_ref WHERE api_id = $1`, [apiId]);
        if (ref.rowCount === 0) {
          throw new Error(`api_id "${apiId}" is not synced locally — call POST /api-asset-refs/sync first`);
        }
        await client.query(`INSERT INTO bundle_asset (bundle_id, api_id) VALUES ($1,$2)`, [bundleId, apiId]);
      }

      const productVersion = await client.query(
        `INSERT INTO product_version (bundle_id, version_number, created_by) VALUES ($1,1,$2) RETURNING *`,
        [bundleId, body.created_by]
      );
      const approval = await client.query(
        `INSERT INTO bundle_approval (product_version_id, status, decided_at) VALUES ($1,'DRAFT', now()) RETURNING *`,
        [productVersion.rows[0].id]
      );

      await client.query("COMMIT");
      return reply.code(201).send({ bundle: bundle.rows[0], product_version: productVersion.rows[0], bundle_approval: approval.rows[0] });
    } catch (err) {
      await client.query("ROLLBACK");
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      client.release();
    }
  });

  app.post("/bundles/:bundleId/offer-versions", async (req, reply) => {
    const { bundleId } = req.params as { bundleId: string };
    const body = req.body as { tier_name: string; quota_limit: number; quota_interval: "DAY" | "MONTH"; price?: number };
    if (!body.tier_name || !body.quota_limit || !body.quota_interval) {
      return reply.code(400).send({ error: "tier_name, quota_limit, quota_interval are required" });
    }

    const pv = await pool.query(
      `SELECT pv.*, (SELECT status FROM bundle_approval WHERE product_version_id = pv.id ORDER BY id DESC LIMIT 1) AS latest_status
       FROM product_version pv WHERE pv.bundle_id = $1 ORDER BY pv.version_number DESC LIMIT 1`,
      [bundleId]
    );
    if (pv.rowCount === 0) return reply.code(404).send({ error: "bundle not found" });
    if (!["DRAFT", "REJECTED"].includes(pv.rows[0].latest_status)) {
      return reply.code(409).send({ error: `cannot add offer_version while status is ${pv.rows[0].latest_status}` });
    }

    const inserted = await pool.query(
      `INSERT INTO offer_version (product_version_id, tier_name, quota_limit, quota_interval, price)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [pv.rows[0].id, body.tier_name, body.quota_limit, body.quota_interval, body.price ?? null]
    );
    return reply.code(201).send({ offer_version: inserted.rows[0] });
  });

  app.post("/bundles/:bundleId/submit", async (req, reply) => {
    const { bundleId } = req.params as { bundleId: string };
    const pv = await latestProductVersion(pool, bundleId);
    if (!pv) return reply.code(404).send({ error: "bundle not found" });
    if (!["DRAFT", "REJECTED"].includes(pv.latest_status)) {
      return reply.code(409).send({ error: `cannot submit while status is ${pv.latest_status}` });
    }
    const approval = await pool.query(
      `INSERT INTO bundle_approval (product_version_id, status, decided_at) VALUES ($1,'PENDING_APPROVAL', now()) RETURNING *`,
      [pv.id]
    );
    return { bundle_approval: approval.rows[0] };
  });

  app.post("/bundles/:bundleId/reject", async (req, reply) => {
    const { bundleId } = req.params as { bundleId: string };
    const body = req.body as { decided_by: string; comments?: string };
    const pv = await latestProductVersion(pool, bundleId);
    if (!pv) return reply.code(404).send({ error: "bundle not found" });
    if (pv.latest_status !== "PENDING_APPROVAL") {
      return reply.code(409).send({ error: `cannot reject while status is ${pv.latest_status}` });
    }
    const approval = await pool.query(
      `INSERT INTO bundle_approval (product_version_id, status, decided_by, comments, decided_at)
       VALUES ($1,'REJECTED',$2,$3, now()) RETURNING *`,
      [pv.id, body.decided_by, body.comments ?? null]
    );
    return { bundle_approval: approval.rows[0] };
  });

  // Approving a bundle ONLY publishes it to the marketplace (DESIGN.md §9
  // step 7) — no Apigee product is created here. Product creation is
  // deferred to the first actual subscription against a tier (below),
  // per the confirmed correction: create on subscribe, not on approve.
  app.post("/bundles/:bundleId/approve", async (req, reply) => {
    const { bundleId } = req.params as { bundleId: string };
    const body = req.body as { decided_by: string; comments?: string };
    const pv = await latestProductVersion(pool, bundleId);
    if (!pv) return reply.code(404).send({ error: "bundle not found" });
    if (pv.latest_status !== "PENDING_APPROVAL") {
      return reply.code(409).send({ error: `cannot approve while status is ${pv.latest_status}` });
    }

    const approval = await pool.query(
      `INSERT INTO bundle_approval (product_version_id, status, decided_by, comments, decided_at)
       VALUES ($1,'APPROVED',$2,$3, now()) RETURNING *`,
      [pv.id, body.decided_by, body.comments ?? null]
    );
    await pool.query(`UPDATE product_version SET published_at = COALESCE(published_at, now()) WHERE id = $1`, [pv.id]);

    return { bundle_approval: approval.rows[0], published: true };
  });

  app.post("/bundles/:bundleId/subscriptions", async (req, reply) => {
    const { bundleId } = req.params as { bundleId: string };
    const body = req.body as { org_id: string; app_id: string; offer_version_id: number };
    if (!body.org_id || !body.app_id || !body.offer_version_id) {
      return reply.code(400).send({ error: "org_id, app_id, offer_version_id are required" });
    }

    const pv = await latestProductVersion(pool, bundleId);
    if (!pv || !pv.published_at) return reply.code(409).send({ error: "bundle has no published, approved version" });

    const subscriberApp = (await pool.query(`SELECT * FROM subscriber_app WHERE app_id = $1`, [body.app_id])).rows[0];
    if (!subscriberApp || !subscriberApp.apigee_developer_email || !subscriberApp.apigee_app_name) {
      return reply.code(409).send({ error: `app_id "${body.app_id}" is not registered — call POST /subscriber-apps first with its real Apigee developer email and app name` });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const sub = await client.query(
        `INSERT INTO subscription (org_id, bundle_id, product_version_id, offer_version_id, app_id, status)
         VALUES ($1,$2,$3,$4,$5,'PENDING') RETURNING *`,
        [body.org_id, bundleId, pv.id, body.offer_version_id, body.app_id]
      );
      await client.query(
        `INSERT INTO outbox_event (aggregate_type, aggregate_id, event_type, payload, target)
         VALUES ('subscription', $1, 'SubscriptionActivated', $2, 'commercial-to-search-sub')`,
        [String(sub.rows[0].id), JSON.stringify(sub.rows[0])]
      );
      await client.query("COMMIT");
      let subscription = sub.rows[0];

      // Real-time trigger: the Apigee product for this tier is created here,
      // lazily, on the first actual subscription — not at bundle-approval
      // time. Idempotent: a second subscriber to the same tier reuses the
      // product api-governance-svc already created (DESIGN.md §9 step 8).
      try {
        const offer = (await pool.query(`SELECT * FROM offer_version WHERE id = $1`, [body.offer_version_id])).rows[0];
        const apiIds = (await pool.query<{ api_id: string }>(`SELECT api_id FROM bundle_asset WHERE bundle_id = $1`, [bundleId])).rows.map((r) => r.api_id);

        const productResp = await createApigeeProduct(config, {
          bundle_id: bundleId,
          offer_version_id: offer.id,
          tier_name: offer.tier_name,
          quota_limit: offer.quota_limit,
          quota_interval: offer.quota_interval,
          api_ids: apiIds,
        });
        await pool.query(`UPDATE subscription SET status = 'PRODUCT_CREATED' WHERE id = $1`, [subscription.id]);

        await attachAppToProduct(config, productResp.apigee_product.id, subscriberApp.apigee_developer_email, subscriberApp.apigee_app_name);
        const activated = await pool.query(`UPDATE subscription SET status = 'ACTIVE' WHERE id = $1 RETURNING *`, [subscription.id]);
        subscription = activated.rows[0];
      } catch (err) {
        app.log.error(err);
        // Leave the subscription at its last-reached status — resilient to
        // this synchronous call failing; a reconciliation pass can retry.
      }

      return reply.code(201).send({ subscription });
    } catch (err) {
      await client.query("ROLLBACK");
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      client.release();
    }
  });

  return app;
}

async function latestProductVersion(pool: pg.Pool, bundleId: string) {
  const pv = await pool.query(
    `SELECT pv.*, (SELECT status FROM bundle_approval WHERE product_version_id = pv.id ORDER BY id DESC LIMIT 1) AS latest_status
     FROM product_version pv WHERE pv.bundle_id = $1 ORDER BY pv.version_number DESC LIMIT 1`,
    [bundleId]
  );
  return pv.rows[0] as (Record<string, unknown> & { id: number; latest_status: string; published_at: string | null }) | undefined;
}
