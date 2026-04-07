import { serve } from "@hono/node-server";
import { loadConfig } from "../config/loader.js";
import { listAgents } from "../config/agent-def.js";
import { setPersistence, loadFromPersistence } from "../config/knowledge.js";
import { FilePersistence } from "../config/knowledge-persistence.js";
import { app } from "../router/handler.js";

const port = Number(process.env.PORT) || 3000;

async function start() {
  // Load agent definitions from clawless.config.ts
  await loadConfig();

  // Load persisted knowledge and secrets
  setPersistence(new FilePersistence());
  await loadFromPersistence();

  const agents = listAgents();
  console.log(`Clawless — ${agents.length} agent(s) loaded: ${agents.join(", ")}`);
  console.log(`Server: http://localhost:${port}`);

  serve({ fetch: app.fetch, port });
}

start().catch((err) => {
  console.error("Failed to start:", err.message);
  process.exit(1);
});
