#!/usr/bin/env node
// Job 7: record-ci-evidence (DESIGN.md §3). Writes a signed-in-place evidence
// record of every gate's outcome for this commit, uploaded as a build
// artifact and later consumed by the post-merge registration job (§4).
//
// Usage: node scripts/record-ci-evidence.mjs --result "job-name=success" [--result ... repeatable]

import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const checks = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--result") {
    const [job, result] = args[i + 1].split("=");
    checks[job] = result;
  }
}

const evidence = {
  commit_sha: process.env.GITHUB_SHA || null,
  pr_number: process.env.GITHUB_EVENT_NUMBER || null,
  run_url: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null,
  recorded_at: new Date().toISOString(),
  checks,
  outcome: Object.values(checks).every((r) => r === "success") ? "PASSED" : "FAILED",
};

writeFileSync("evidence.json", JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify(evidence, null, 2));

if (evidence.outcome !== "PASSED") {
  process.exitCode = 1;
}
