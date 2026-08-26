export interface Config {
  port: number;
  // Local dev (TCP): set databaseUrl. Cloud Run + Cloud SQL (unix socket):
  // set cloudSqlInstanceConnectionName + dbUser/dbPassword/dbName instead.
  databaseUrl?: string;
  cloudSqlInstanceConnectionName?: string;
  dbUser?: string;
  dbPassword?: string;
  dbName?: string;
  governanceSvcUrl: string;
  outboxPollIntervalMs: number;
  // When set, requests to api-governance-svc carry an ID token minted by
  // impersonating this service account (see gcpAuth.ts) — required once
  // that service is deployed behind Cloud Run's IAM auth. Left unset,
  // calls go out unauthenticated (fine for a local, unauthenticated dev
  // instance).
  governanceSvcInvokerSa?: string;
  // Pub/Sub topic the outbox worker publishes to for the
  // 'commercial-to-search-sub' target (DESIGN.md §9.11).
  pubsubSearchSyncTopic?: string;
  gcpProjectId?: string;
  // Outbox jobs (e.g. apigee-provisioning) retry up to this many times
  // before the worker marks them FAILED and stops picking them up.
  outboxMaxAttempts: number;
}

export function loadConfig(): Config {
  const port = Number(process.env.PORT ?? "4102");
  const databaseUrl = process.env.DATABASE_URL;
  const cloudSqlInstanceConnectionName = process.env.INSTANCE_CONNECTION_NAME;
  const dbUser = process.env.DB_USER;
  const dbPassword = process.env.DB_PASSWORD;
  const dbName = process.env.DB_NAME;
  const governanceSvcUrl = process.env.GOVERNANCE_SVC_URL ?? "http://localhost:4101";
  const outboxPollIntervalMs = Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? "3000");
  const governanceSvcInvokerSa = process.env.GOVERNANCE_SVC_INVOKER_SA;
  const pubsubSearchSyncTopic = process.env.PUBSUB_SEARCH_SYNC_TOPIC;
  const gcpProjectId = process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT;
  const outboxMaxAttempts = Number(process.env.OUTBOX_MAX_ATTEMPTS ?? "5");

  if (!databaseUrl && !cloudSqlInstanceConnectionName) {
    throw new Error("either DATABASE_URL or INSTANCE_CONNECTION_NAME (+ DB_USER/DB_PASSWORD/DB_NAME) is required");
  }

  return { port, databaseUrl, cloudSqlInstanceConnectionName, dbUser, dbPassword, dbName, governanceSvcUrl, outboxPollIntervalMs, governanceSvcInvokerSa, pubsubSearchSyncTopic, gcpProjectId, outboxMaxAttempts };
}
