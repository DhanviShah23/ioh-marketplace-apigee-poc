#!/usr/bin/env node
// Regenerates _index/api-ids.json (DESIGN.md §1.4) — a non-authoritative
// cache for O(1) uniqueness lookups. Git itself (ioh/apis/*, vendor/*/apis/*)
// remains the source of truth; this file is only ever derived from it.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { globSync } from "glob";
import yaml from "js-yaml";
import { findAllApiIdFolders } from "./lib/api-id.mjs";

// findAllApiIdFolders' `namespace` is an internal bucket key ("ioh", or the
// vendor-org-id) used for cross-tree uniqueness comparisons — it is not the
// business-domain namespace the index should report (DESIGN.md §1: "for
// IOH-owned APIs, the owning business domain, e.g. payments"). That value
// only lives in each api-id's metadata.yaml, so read it here for real.
function resolveNamespace({ origin, namespace, path }) {
  const metadataPath = `${path}/metadata.yaml`;
  if (existsSync(metadataPath)) {
    const metadata = yaml.load(readFileSync(metadataPath, "utf8"));
    if (metadata?.namespace) return metadata.namespace;
  }
  return namespace; // fallback: "ioh" or the vendor-org-id
}

const apis = findAllApiIdFolders(globSync)
  .map((folder) => ({
    api_id: folder.apiId,
    namespace: resolveNamespace(folder),
    origin: folder.origin,
    path: folder.path,
  }))
  .sort((a, b) => a.api_id.localeCompare(b.api_id));

writeFileSync("_index/api-ids.json", JSON.stringify({ apis }, null, 2) + "\n");
console.log(`✓ _index/api-ids.json regenerated with ${apis.length} api-id(s)`);
