export interface Config {
  port: number;
  databaseUrl: string;
  governanceSvcUrl: string;
  outboxPollIntervalMs: number;
  // When set, requests to api-governance-svc carry an ID token minted by
  // impersonating this service account (see gcpAuth.ts) — required once
  // that service is deployed behind Cloud Run's IAM auth. Left unset,
  // calls go out unauthenticated (fine for a local, unauthenticated dev
  // instance).
  governanceSvcInvokerSa?: string;
}

export function loadConfig(): Config {
  const port = Number(process.env.PORT ?? "4102");
  const databaseUrl = process.env.DATABASE_URL;
  const governanceSvcUrl = process.env.GOVERNANCE_SVC_URL ?? "http://localhost:4101";
  const outboxPollIntervalMs = Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? "3000");
  const governanceSvcInvokerSa = process.env.GOVERNANCE_SVC_INVOKER_SA;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  return { port, databaseUrl, governanceSvcUrl, outboxPollIntervalMs, governanceSvcInvokerSa };
}
