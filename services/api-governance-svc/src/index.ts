import { loadConfig } from "./config.js";
import { createPool, ensureSchema } from "./db.js";
import { createRealApigeeClient, createFakeApigeeClient } from "./apigee.js";
import { buildServer } from "./server.js";

const config = loadConfig();
const pool = createPool(config);
await ensureSchema(pool);

const apigee = config.useFakeApigeeClient ? createFakeApigeeClient() : createRealApigeeClient(config);
const app = buildServer(pool, apigee, config);

await app.listen({ host: "0.0.0.0", port: config.port });
