export interface Config {
  port: number;
  databaseUrl: string;
  apigeeOrg: string;
  apigeeEnv: string;
  useFakeApigeeClient: boolean;
}

export function loadConfig(): Config {
  const port = Number(process.env.PORT ?? "4101");
  const databaseUrl = process.env.DATABASE_URL;
  const apigeeOrg = process.env.APIGEE_ORG ?? "searceapigeex";
  const apigeeEnv = process.env.APIGEE_ENV ?? "dev1";
  const useFakeApigeeClient = process.env.USE_FAKE_APIGEE_CLIENT === "true";

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  return { port, databaseUrl, apigeeOrg, apigeeEnv, useFakeApigeeClient };
}
