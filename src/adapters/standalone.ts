import { serve } from "@hono/node-server";
import { loadConfig } from "../config/loader.js";
import { listAgents } from "../config/agent-def.js";
import { setPersistence, loadFromPersistence } from "../config/knowledge.js";
import { setToolPersistence, loadToolsFromPersistence, listTools } from "../config/tool-store.js";
import { FilePersistence } from "../config/knowledge-persistence.js";
import { app } from "../router/handler.js";

const port = Number(process.env.PORT) || 3000;

async function start() {
  await loadConfig();

  // Load persisted knowledge, secrets, and tools
  const fp = new FilePersistence();
  setPersistence(fp);
  setToolPersistence(fp);
  await Promise.all([loadFromPersistence(), loadToolsFromPersistence()]);

  const agents = listAgents();
  const tools = listTools();
  console.log(`Clawless — ${agents.length} agent(s): ${agents.join(", ")}`);
  if (tools.length > 0) {
    console.log(`  ${tools.length} dynamic tool(s): ${tools.map(t => t.name).join(", ")}`);
  }
  console.log(`Server: http://localhost:${port}`);

  serve({ fetch: app.fetch, port });
}

start().catch((err) => {
  console.error("Failed to start:", err.message);
  process.exit(1);
});
