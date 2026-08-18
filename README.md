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

## Services (`api-governance-svc`, `commercial-catalog-svc`)

Both are real, running Node.js/TypeScript/Fastify services under `services/`,
backed by Postgres, with **live** Apigee X integration — verified end to end
against the real `searceapigeex` org / `dev1` environment:

- **`api-governance-svc`** (`services/api-governance-svc`) — `POST /api-asset-versions`
  registers a spec version and, in the same call, builds a real Apigee proxy
  bundle (VerifyAPIKey + Quota policies, target from `servers[].url`),
  imports it, and deploys it to `dev1` (`override=true`, so re-registering
  the same `vN` replaces the previously deployed revision). `POST
  /apigee-products` creates a real Apigee API product for one tier, with
  `quota`/`quotaInterval`/`quotaTimeUnit` set from the tier — the running
  proxy's `Quota` policy reads these back at request time via Apigee's
  standard `verifyapikey.*.apiproduct.developer.quota.*` flow variables, so
  a tier's quota genuinely flows from the bundle into enforcement on the
  proxy. All Apigee calls live behind this service — `commercial-catalog-svc`
  never calls Apigee directly (per DESIGN.md §7's boundary).
- **`commercial-catalog-svc`** (`services/commercial-catalog-svc`) — bundle
  creation, `offer_version` tiers (with a `price` column, per the confirmed
  "field only, no billing logic" decision), the `DRAFT → PENDING_APPROVAL →
  APPROVED/REJECTED` approval loop (append-only `bundle_approval` rows, fixed
  `product_version_id` through the loop), and subscriptions. **The moment a
  bundle flips to `APPROVED`, it calls `api-governance-svc` once per
  `offer_version` (tier) to create that tier's Apigee product in real time**
  — this was a confirmed change from DESIGN.md §9's original per-subscription
  timing. Subscriptions write `subscription` + `outbox_event` in one
  transaction; a poller (`src/outboxWorker.ts`) delivers pending events
  independently of that transaction's fate (verified: `PENDING` immediately
  after commit, `SENT` a few seconds later via the poller).

**Auth caveat (read before deploying):** the client authenticates by
preferring the active `gcloud auth print-access-token` identity over ADC —
on this dev machine the well-known ADC file belonged to a stale, wrong
Google account, while the `gcloud` CLI session was the correctly-authorized
one. For a real deployment (e.g. Cloud Run), swap to a dedicated service
account key / Workload Identity instead of relying on either personal
credential path.

**Run locally:**
```bash
docker compose up -d --build   # postgres-governance:5533, postgres-catalog:5534,
                                # api-governance-svc:4101, commercial-catalog-svc:4102
```
The compose file mounts this host's ADC file as a fallback; if your Apigee
IAM identity differs from your ADC identity (as it did here), run the
services directly on the host instead (`npm run start` in each
`services/*` directory, with `DATABASE_URL` pointed at `localhost:5533` /
`localhost:5534`) so the client can shell out to the correctly-authenticated
`gcloud` CLI.

**Real-time proxy creation on merge** (`.github/workflows/post-merge.yml`)
calls `api-governance-svc` via a `GOVERNANCE_SVC_URL` repo/environment
variable — **unset by default**. A GitHub-hosted Actions runner can only
reach a *publicly deployed* `api-governance-svc` (e.g. on Cloud Run), which
this build does not provision — that's a real, billable, internet-facing
deployment decision left for you to make explicitly. Until `GOVERNANCE_SVC_URL`
is set, the workflow logs the registration payload in dry-run mode instead
of failing.

## Not yet implemented

GCS mirroring/checksum-verification-against-GCS from DESIGN.md §4 (the
services compute and store the checksum, but don't yet mirror the spec to
GCS), the `attach-app`-to-product step's full KYC/KYB-backed app model, and
an actual public deployment of either service.

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
