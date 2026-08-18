#!/usr/bin/env node
// DESIGN.md §4: post-merge notification to api-governance-svc, which
// creates/deploys the real Apigee X proxy for this version (§9).
//
// Usage: node scripts/register-api-asset-version.mjs --spec <path> --commit <sha> --repo <owner/repo> --actor <email>

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import yaml from "js-yaml";
import { parseSpecPath } from "./lib/api-id.mjs";

function getArg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

const specPath = getArg("spec");
const commitSha = getArg("commit");
const repo = getArg("repo");
const actor = getArg("actor") ?? "github-actions-bot";
const governanceSvcUrl = process.env.GOVERNANCE_SVC_URL;

if (!specPath || !commitSha || !repo) {
  console.error("usage: register-api-asset-version.mjs --spec <path> --commit <sha> --repo <owner/repo> [--actor <email>]");
  process.exit(2);
}

const parsed = parseSpecPath(specPath);
if (!parsed) {
  console.error(`"${specPath}" does not match the required ioh/apis/{id}/v{N}/openapi.yaml layout`);
  process.exit(1);
}

const raw = readFileSync(specPath, "utf8");
const spec = yaml.load(raw);
const checksum = createHash("sha256").update(raw, "utf8").digest("hex");

const payload = {
  api_id: parsed.apiId,
  namespace: parsed.namespace,
  origin: parsed.origin,
  vendor_org_id: parsed.vendorOrgId,
  major_version: parsed.majorVersion,
  oas_semantic_version: spec?.info?.version,
  repo,
  path: specPath,
  commit_sha: commitSha,
  checksum_sha256: checksum,
  created_by: actor,
  spec,
};

if (!governanceSvcUrl) {
  console.log("[dry-run] GOVERNANCE_SVC_URL is not set — would POST the following to api-governance-svc:");
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

const res = await fetch(`${governanceSvcUrl}/api-asset-versions`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
const body = await res.json();
console.log(JSON.stringify(body, null, 2));

if (!res.ok || body.status === "FAILED") {
  console.error(`api-governance-svc reported failure registering ${specPath}`);
  process.exit(1);
}
