export interface Config {
  port: number;
  // Local dev (TCP): set databaseUrl. Cloud Run + Cloud SQL (unix socket):
  // set cloudSqlInstanceConnectionName + dbUser/dbPassword/dbName instead —
  // Cloud Run has no TCP path to Cloud SQL, only the mounted socket.
  databaseUrl?: string;
  cloudSqlInstanceConnectionName?: string;
  dbUser?: string;
  dbPassword?: string;
  dbName?: string;
  apigeeOrg: string;
  apigeeEnv: string;
  useFakeApigeeClient: boolean;
  gcsAssetsBucket: string;
  gcsLogsBucket: string;
}

export function loadConfig(): Config {
  const port = Number(process.env.PORT ?? "4101");
  const databaseUrl = process.env.DATABASE_URL;
  const cloudSqlInstanceConnectionName = process.env.INSTANCE_CONNECTION_NAME;
  const dbUser = process.env.DB_USER;
  const dbPassword = process.env.DB_PASSWORD;
  const dbName = process.env.DB_NAME;
  const apigeeOrg = process.env.APIGEE_ORG ?? "searceapigeex";
  const apigeeEnv = process.env.APIGEE_ENV ?? "dev1";
  const useFakeApigeeClient = process.env.USE_FAKE_APIGEE_CLIENT === "true";
  const gcsAssetsBucket = process.env.GCS_ASSETS_BUCKET ?? "ioh-marketplace-apigee-poc-assets";
  const gcsLogsBucket = process.env.GCS_LOGS_BUCKET ?? "ioh-marketplace-apigee-poc-logs";

  if (!databaseUrl && !cloudSqlInstanceConnectionName) {
    throw new Error("either DATABASE_URL or INSTANCE_CONNECTION_NAME (+ DB_USER/DB_PASSWORD/DB_NAME) is required");
  }

  return { port, databaseUrl, cloudSqlInstanceConnectionName, dbUser, dbPassword, dbName, apigeeOrg, apigeeEnv, useFakeApigeeClient, gcsAssetsBucket, gcsLogsBucket };
}
