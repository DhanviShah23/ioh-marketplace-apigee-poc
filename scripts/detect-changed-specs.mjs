#!/usr/bin/env node
// Helper used by both pre-merge and (later) post-merge workflows to compute
// which openapi.yaml files were added/modified or deleted between two refs,
// under ioh/** and vendor/**. Emits GitHub Actions step outputs.
//
// Usage: node scripts/detect-changed-specs.mjs <baseRef> <headRef>

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const [baseRef, headRef] = process.argv.slice(2);
if (!baseRef || !headRef) {
  console.error("usage: detect-changed-specs.mjs <baseRef> <headRef>");
  process.exit(2);
}

const SPEC_PATH_RE = /^(ioh\/apis\/[^/]+\/v\d+\/openapi\.ya?ml|vendor\/[^/]+\/apis\/[^/]+\/v\d+\/openapi\.ya?ml)$/;

function diffNameStatus(base, head) {
  const out = execFileSync("git", ["diff", "--name-status", `${base}..${head}`], {
    encoding: "utf8",
  });
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split("\t");
      return { status, path: rest[rest.length - 1] };
    });
}

const changes = diffNameStatus(baseRef, headRef);

const addedOrModified = changes
  .filter((c) => (c.status === "A" || c.status === "M") && SPEC_PATH_RE.test(c.path))
  .map((c) => ({ path: c.path }));

const deleted = changes
  .filter((c) => c.status === "D")
  .map((c) => c.path);

const output = {
  specs: JSON.stringify(addedOrModified),
  deleted: JSON.stringify(deleted),
  has_specs: addedOrModified.length > 0 ? "true" : "false",
};

console.log(JSON.stringify(output, null, 2));

const githubOutput = process.env.GITHUB_OUTPUT;
if (githubOutput) {
  for (const [key, value] of Object.entries(output)) {
    appendFileSync(githubOutput, `${key}=${value}\n`);
  }
}
