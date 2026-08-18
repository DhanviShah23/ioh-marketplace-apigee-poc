#!/usr/bin/env node
// Job 5: validate-versioning (DESIGN.md §3), extended to also cover the
// api-id identity guarantees from §1 that this same script already has the
// path/spec context to check: format, path<->x-ioh-api-id agreement,
// cross-namespace uniqueness, and immutability (no deleting an existing
// apis/{api-id}/ path).
//
// Usage:
//   node scripts/validate-versioning.mjs --changed <specPath>
//   node scripts/validate-versioning.mjs --check-immutability '<json array of deleted paths>'

import { readFileSync } from "node:fs";
import { globSync } from "glob";
import yaml from "js-yaml";
import semver from "semver";
import { validateApiIdFormat, parseSpecPath, findAllApiIdFolders } from "./lib/api-id.mjs";

function fail(messages) {
  for (const m of messages) console.error(`✗ ${m}`);
  process.exit(1);
}

function checkImmutability(deletedPathsJson) {
  const deleted = JSON.parse(deletedPathsJson || "[]");
  const offending = deleted.filter((p) => /\/apis\/[^/]+\//.test(p));
  if (offending.length > 0) {
    fail(
      offending.map(
        (p) => `deletion of "${p}" touches an existing apis/{api-id}/ path — retiring an API is a lifecycle_status change, never a deletion (DESIGN.md §1.3)`
      )
    );
  }
  console.log("✓ no existing apis/{api-id}/ paths were deleted");
}

function checkVersioning(specPath) {
  const parsed = parseSpecPath(specPath);
  if (!parsed) {
    fail([
      `"${specPath}" does not match the required layout ioh/apis/{api-id}/v{N}/openapi.yaml or vendor/{org}/apis/{api-id}/v{N}/openapi.yaml`,
    ]);
  }
  const { apiId, majorVersion, origin } = parsed;

  const errors = validateApiIdFormat(apiId);

  const doc = yaml.load(readFileSync(specPath, "utf8"));

  const declaredApiId = doc?.info?.["x-ioh-api-id"];
  if (declaredApiId !== apiId) {
    errors.push(
      `info.x-ioh-api-id ("${declaredApiId}") must match the folder path's api-id ("${apiId}")`
    );
  }

  const version = doc?.info?.version;
  if (!version || !semver.valid(version)) {
    errors.push(`info.version ("${version}") must be a valid semver string`);
  } else if (semver.major(version) !== majorVersion) {
    errors.push(
      `info.version major (${semver.major(version)}) must match the v${majorVersion}/ folder`
    );
  }

  const servers = Array.isArray(doc?.servers) ? doc.servers : [];
  const versionSegment = `/v${majorVersion}`;
  const hasMatchingServer = servers.some((s) => (s.url || "").includes(versionSegment));
  if (!hasMatchingServer) {
    errors.push(
      `at least one servers[].url must contain the "${versionSegment}" segment`
    );
  }

  // Uniqueness (DESIGN.md §1.2): the same api-id string must not resolve to
  // more than one distinct owning path in the repo (e.g. both ioh/apis/X and
  // vendor/some-org/apis/X, or two different vendor orgs).
  const allFolders = findAllApiIdFolders(globSync);
  const owners = new Set(
    allFolders.filter((f) => f.apiId === apiId).map((f) => `${f.origin}:${f.namespace}`)
  );
  if (owners.size > 1) {
    errors.push(
      `api-id "${apiId}" resolves to more than one owner (${[...owners].join(", ")}) — api-ids must be globally unique`
    );
  }
  if (!owners.has(`${origin}:${parsed.namespace}`)) {
    // Defensive: should be impossible since specPath itself is one of the folders scanned.
    errors.push(`internal error: could not locate "${specPath}" among scanned api-id folders`);
  }

  if (errors.length > 0) fail(errors);

  console.log(`✓ ${specPath}: versioning and identity checks passed`);
}

const args = process.argv.slice(2);
const changedIdx = args.indexOf("--changed");
const immutabilityIdx = args.indexOf("--check-immutability");

if (changedIdx !== -1) {
  checkVersioning(args[changedIdx + 1]);
} else if (immutabilityIdx !== -1) {
  checkImmutability(args[immutabilityIdx + 1]);
} else {
  console.error("usage: validate-versioning.mjs --changed <path> | --check-immutability '<json>'");
  process.exit(2);
}
