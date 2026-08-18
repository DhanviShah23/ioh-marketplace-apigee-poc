# ioh-marketplace-apigee-poc

Spec repo + pre-merge governance CI for IOH's API onboarding pipeline. Full
design: [`DESIGN.md`](./DESIGN.md).

## What's implemented in this scaffold

- **Git layout** (§2): `ioh/apis/{api-id}/v{N}/openapi.yaml`, `vendor/{org}/apis/{api-id}/v{N}/openapi.yaml`, `metadata.yaml` per api-id, `_index/api-ids.json` cache.
- **CODEOWNERS** (`.github/CODEOWNERS`) — placeholder teams, see below.
- **Pre-merge CI** (§3, `.github/workflows/pre-merge.yml`) — all 7 jobs:
  1. `validate-oas-structure` — Redocly CLI
  2. `lint-ioh-conventions` — Spectral, `spectral/ioh-ruleset.yaml`
  3. `validate-naming` — Spectral, `spectral/naming-ruleset.yaml`
  4. `validate-security` — Spectral, `spectral/security-ruleset.yaml`
  5. `validate-versioning` — `scripts/validate-versioning.mjs` (also covers §1's api-id format/uniqueness checks)
  6. `compatibility-check` — `oasdiff` action, breaking-change diff vs the same path's base-branch version
  7. `record-ci-evidence` — `scripts/record-ci-evidence.mjs`, uploads `evidence.json` as a build artifact
  - plus `validate-immutability`, enforcing §1.3 (no deleting an existing `apis/{api-id}/` path)
- One worked example: `ioh/apis/payments-wallet-transfer/v1/openapi.yaml`.

**Job 8 (branch-protection gate) is a repo setting, not code.** After pushing this scaffold, configure on GitHub (Settings → Branches → `main`):
- Require status checks: `validate-oas-structure`, `lint-ioh-conventions`, `validate-naming`, `validate-security`, `validate-versioning`, `validate-immutability`, `compatibility-check`, `record-ci-evidence`
- Require a pull request before merging, with review from Code Owners
- Require review from someone other than the last pusher (GitHub's built-in same-author restriction)
- Squash-merge only (recommended in DESIGN.md §4, so the merge commit is byte-identical to the CI-validated PR head)

## Not yet implemented

Everything in DESIGN.md §4 onward — the post-merge workflow (GCS mirroring,
checksum verification, `ApiAssetVersion` registration in `api-governance-svc`),
`api-governance-svc`/`commercial-catalog-svc` themselves, Apigee X proxy
creation, and the productization/subscription/outbox flow. This scaffold
covers the Git layout, CODEOWNERS, and pre-merge CI only.

## CODEOWNERS placeholders

`.github/CODEOWNERS` currently points every path at `@ioh-org/api-governance-team`
or `@ioh-org/platform-team` — these are **placeholders**. Replace them with
real GitHub teams before turning on "Require review from Code Owners," and
add one line per domain as they onboard (see comments in the file).

## Local usage

```bash
npm install

# Lint one spec against all three rulesets + structural validation
npm run lint:oas -- ioh/apis/payments-wallet-transfer/v1/openapi.yaml
npm run lint:conventions -- ioh/apis/payments-wallet-transfer/v1/openapi.yaml
npm run lint:naming -- ioh/apis/payments-wallet-transfer/v1/openapi.yaml
npm run lint:security -- ioh/apis/payments-wallet-transfer/v1/openapi.yaml

# Versioning / identity checks
npm run validate:versioning -- --changed ioh/apis/payments-wallet-transfer/v1/openapi.yaml

# Regenerate the api-id index cache
npm run index:generate
```

## Adding a new API

1. IOH-owned: create `ioh/apis/{api-id}/v1/openapi.yaml` and `metadata.yaml`.
   Vendor: create `vendor/{vendor-org-id}/apis/{api-id}/v1/openapi.yaml` and `metadata.yaml`.
2. Set `info.x-ioh-api-id` in the spec to exactly match `{api-id}` in the folder path.
3. Open a PR — the 7 pre-merge jobs run automatically; a CODEOWNERS review is required to merge.
4. A breaking change to an *existing* `vN/` is rejected outright — open a new `v{N+1}/` folder instead (§5).
