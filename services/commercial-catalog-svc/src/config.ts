export interface Config {
  port: number;
  databaseUrl: string;
  governanceSvcUrl: string;
  outboxPollIntervalMs: number;
}

export function loadConfig(): Config {
  const port = Number(process.env.PORT ?? "4102");
  const databaseUrl = process.env.DATABASE_URL;
  const governanceSvcUrl = process.env.GOVERNANCE_SVC_URL ?? "http://localhost:4101";
  const outboxPollIntervalMs = Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? "3000");

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  return { port, databaseUrl, governanceSvcUrl, outboxPollIntervalMs };
}
