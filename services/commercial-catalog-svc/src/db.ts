import pg from "pg";
import type { Config } from "./config.js";

export function createPool(config: Config): pg.Pool {
  if (config.cloudSqlInstanceConnectionName) {
    return new pg.Pool({
      host: `/cloudsql/${config.cloudSqlInstanceConnectionName}`,
      user: config.dbUser,
      password: config.dbPassword,
      database: config.dbName,
    });
  }
  return new pg.Pool({ connectionString: config.databaseUrl });
}

// DESIGN.md §8. offer_version includes `price` per the confirmed decision
// to add the column now (no billing logic) so no later migration is needed.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS api_asset_ref (
  api_id                 text PRIMARY KEY,
  major_version          int NOT NULL,
  api_asset_version_ref  bigint NOT NULL,
  display_name           text,
  status                 text NOT NULL
);

CREATE TABLE IF NOT EXISTS bundle (
  bundle_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  visibility    text NOT NULL DEFAULT 'RESTRICTED',
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bundle_asset (
  bundle_id  uuid NOT NULL REFERENCES bundle(bundle_id),
  api_id     text NOT NULL REFERENCES api_asset_ref(api_id),
  PRIMARY KEY (bundle_id, api_id)
);

CREATE TABLE IF NOT EXISTS product_version (
  id              bigserial PRIMARY KEY,
  bundle_id       uuid NOT NULL REFERENCES bundle(bundle_id),
  version_number  int NOT NULL,
  published_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text NOT NULL,
  UNIQUE (bundle_id, version_number)
);

CREATE TABLE IF NOT EXISTS offer_version (
  id                   bigserial PRIMARY KEY,
  product_version_id  bigint NOT NULL REFERENCES product_version(id),
  tier_name            text NOT NULL,
  quota_limit          int NOT NULL,
  quota_interval       text NOT NULL,
  price                numeric(12,2),
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bundle_approval (
  id                   bigserial PRIMARY KEY,
  product_version_id   bigint NOT NULL REFERENCES product_version(id),
  status               text NOT NULL,
  decided_by           text,
  comments             text,
  decided_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS restricted_access_grant (
  id              bigserial PRIMARY KEY,
  bundle_id       uuid NOT NULL REFERENCES bundle(bundle_id),
  grantee_org_id  text NOT NULL,
  granted_by      text NOT NULL,
  granted_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz
);

CREATE TABLE IF NOT EXISTS subscriber_app (
  app_id                  text PRIMARY KEY,
  org_id                  text NOT NULL,
  apigee_developer_email  text,
  apigee_app_name         text,
  created_at              timestamptz NOT NULL DEFAULT now()
);
-- CREATE TABLE IF NOT EXISTS won't add columns to an already-existing
-- table, so these are explicit and idempotent for the already-running DB.
ALTER TABLE subscriber_app ADD COLUMN IF NOT EXISTS apigee_developer_email text;
ALTER TABLE subscriber_app ADD COLUMN IF NOT EXISTS apigee_app_name text;

CREATE TABLE IF NOT EXISTS subscription (
  id                   bigserial PRIMARY KEY,
  org_id               text NOT NULL,
  bundle_id            uuid NOT NULL REFERENCES bundle(bundle_id),
  product_version_id   bigint NOT NULL REFERENCES product_version(id),
  offer_version_id     bigint NOT NULL REFERENCES offer_version(id),
  app_id               text NOT NULL REFERENCES subscriber_app(app_id),
  status               text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outbox_event (
  id              bigserial PRIMARY KEY,
  aggregate_type  text NOT NULL,
  aggregate_id    text NOT NULL,
  event_type      text NOT NULL,
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'PENDING',
  target          text NOT NULL,
  attempts        int NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);
`;

export async function ensureSchema(pool: pg.Pool): Promise<void> {
  await pool.query(SCHEMA_SQL);
}
