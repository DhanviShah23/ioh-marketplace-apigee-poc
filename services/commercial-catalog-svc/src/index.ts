import { loadConfig } from "./config.js";
import { createPool, ensureSchema } from "./db.js";
import { buildServer } from "./server.js";
import { startOutboxWorker } from "./outboxWorker.js";

const config = loadConfig();
const pool = createPool(config);
await ensureSchema(pool);

startOutboxWorker(pool, config);

const app = buildServer(pool, config);
await app.listen({ host: "0.0.0.0", port: config.port });
