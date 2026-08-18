import pg from "pg";
import type { Config } from "./config.js";

export function createPool(config: Config): pg.Pool {
  return new pg.Pool({ connectionString: config.databaseUrl });
}

// DESIGN.md §7, with apigee_product keyed off offer_version_ref instead of
// subscription_ref: products are created once per approved bundle tier
// (offer_version), not lazily per-subscription (decision confirmed 2026-08-18).
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS api (
  api_id            text PRIMARY KEY,
  namespace         text NOT NULL,
  origin            text NOT NULL,
  owning_domain     text,
  vendor_org_id     text,
  lifecycle_status  text NOT NULL DEFAULT 'ACTIVE',
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        text NOT NULL
);

CREATE TABLE IF NOT EXISTS api_asset_version (
  id                       bigserial PRIMARY KEY,
  api_id                   text NOT NULL REFERENCES api(api_id),
  major_version            int NOT NULL,
  oas_semantic_version     text NOT NULL,
  repo                     text NOT NULL,
  path                     text NOT NULL,
  commit_sha               text NOT NULL,
  checksum_sha256          text NOT NULL,
  gcs_spec_uri             text,
  governance_evidence_uri  text,
  predecessor_version_id   bigint REFERENCES api_asset_version(id),
  status                   text NOT NULL DEFAULT 'REGISTERING',
  registered_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (api_id, commit_sha)
);

CREATE TABLE IF NOT EXISTS apigee_proxy (
  id                     bigserial PRIMARY KEY,
  api_asset_version_id   bigint NOT NULL REFERENCES api_asset_version(id),
  apigee_org             text NOT NULL,
  apigee_env             text NOT NULL,
  proxy_name             text NOT NULL,
  revision               int NOT NULL,
  deployed_at            timestamptz,
  status                 text NOT NULL
);

CREATE TABLE IF NOT EXISTS apigee_product (
  id                     bigserial PRIMARY KEY,
  offer_version_ref      bigint NOT NULL,
  bundle_id_ref          text,
  apigee_org             text NOT NULL,
  apigee_product_name    text NOT NULL UNIQUE,
  quota_limit            int NOT NULL,
  quota_interval         text NOT NULL,
  proxy_names            text[] NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  status                 text NOT NULL
);
`;

export async function ensureSchema(pool: pg.Pool): Promise<void> {
  await pool.query(SCHEMA_SQL);
}
