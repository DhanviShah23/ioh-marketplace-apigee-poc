import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

const config = loadConfig();
const app = buildServer(config);
await app.listen({ host: "0.0.0.0", port: config.port });
