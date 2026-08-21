import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Config } from "./config.js";
import { validateApiId } from "./validate.js";
import { getBranchHeadSha, createBranch, getFileSha, putFile, openPullRequest } from "./github.js";
import { catalogClient } from "./catalogClient.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function buildServer(config: Config) {
  const app = Fastify({ logger: true });

  app.register(fastifyStatic, {
    root: join(__dirname, "..", "public"),
  });

  app.get("/health", async () => ({ status: "ok" }));

  // Marketplace proxy routes: the browser talks to ioh-portal only;
  // ioh-portal authenticates to the private commercial-catalog-svc
  // server-side, so no backend service other than this one is public.
  app.get("/api/bundles", async (req, reply) => {
    const { status } = req.query as { status?: string };
    try {
      return await catalogClient.listBundles(config, status);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/bundles/:bundleId", async (req, reply) => {
    const { bundleId } = req.params as { bundleId: string };
    try {
      return await catalogClient.getBundle(config, bundleId);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/bundles/:bundleId/subscriptions", async (req, reply) => {
    const { bundleId } = req.params as { bundleId: string };
    try {
      return await catalogClient.subscribe(config, bundleId, req.body);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/bundles/:bundleId/approve", async (req, reply) => {
    const { bundleId } = req.params as { bundleId: string };
    try {
      return await catalogClient.approve(config, bundleId, req.body);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/bundles/:bundleId/reject", async (req, reply) => {
    const { bundleId } = req.params as { bundleId: string };
    try {
      return await catalogClient.reject(config, bundleId, req.body);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/spec-submissions", async (req, reply) => {
    const body = req.body as {
      api_id: string;
      origin: "IOH" | "VENDOR";
      namespace?: string;
      vendor_org_id?: string;
      major_version: number;
      spec_content: string;
      submitted_by: string;
    };

    const required = ["api_id", "origin", "major_version", "spec_content", "submitted_by"] as const;
    for (const field of required) {
      if (!body[field]) return reply.code(400).send({ error: `missing required field: ${field}` });
    }
    if (body.origin === "VENDOR" && !body.vendor_org_id) {
      return reply.code(400).send({ error: "vendor_org_id is required when origin is VENDOR" });
    }

    const idErrors = validateApiId(body.api_id);
    if (idErrors.length > 0) return reply.code(400).send({ error: idErrors.join("; ") });

    const nsPrefix = body.origin === "VENDOR" ? `vendor/${body.vendor_org_id}/apis` : "ioh/apis";
    const specPath = `${nsPrefix}/${body.api_id}/v${body.major_version}/openapi.yaml`;
    const metadataPath = `${nsPrefix}/${body.api_id}/metadata.yaml`;
    const branchName = `spec-submission/${body.api_id}-${Date.now()}`;

    try {
      const baseSha = await getBranchHeadSha(config, config.defaultBaseBranch);
      await createBranch(config, branchName, baseSha);

      const existingSpecSha = await getFileSha(config, specPath, config.defaultBaseBranch);
      await putFile(config, {
        path: specPath,
        branch: branchName,
        content: body.spec_content,
        message: `${existingSpecSha ? "Update" : "Add"} ${body.api_id} v${body.major_version}`,
        sha: existingSpecSha ?? undefined,
      });

      const existingMetadataSha = await getFileSha(config, metadataPath, config.defaultBaseBranch);
      if (!existingMetadataSha) {
        const metadataYaml = [
          `api_id: ${body.api_id}`,
          `namespace: ${body.origin === "VENDOR" ? body.vendor_org_id : (body.namespace ?? "ioh")}`,
          `origin: ${body.origin}`,
          `owning_domain: ${body.namespace ?? "null"}`,
          `vendor_org_id: ${body.origin === "VENDOR" ? body.vendor_org_id : "null"}`,
          `lifecycle_status: ACTIVE`,
          `created_by: ${body.submitted_by}`,
        ].join("\n") + "\n";
        await putFile(config, {
          path: metadataPath,
          branch: branchName,
          content: metadataYaml,
          message: `Add metadata for ${body.api_id}`,
        });
      }

      const pr = await openPullRequest(config, {
        branch: branchName,
        base: config.defaultBaseBranch,
        title: `${existingSpecSha ? "Update" : "Add"} ${body.api_id} (v${body.major_version})`,
        body: `Submitted via the IOH portal by ${body.submitted_by}.\n\nSpec path: \`${specPath}\``,
      });

      return reply.code(201).send({ branch: branchName, spec_path: specPath, pr_number: pr.number, pr_url: pr.html_url });
    } catch (err) {
      app.log.error(err);
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return app;
}
