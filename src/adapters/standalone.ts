import { serve } from "@hono/node-server";
import { initializeClawless } from "../bootstrap.js";
import { listAgents } from "../config/agent-def.js";
import { listTools } from "../config/tool-store.js";
import { app } from "../router/handler.js";

const port = Number(process.env.PORT) || 3000;

async function start() {
  await initializeClawless();

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
