import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { getModel } from "@mariozechner/pi-ai";
import type { AgentDef } from "../config/agent-def.js";
import { runAgent } from "../runtime/agent.js";
import { runAgentStream } from "../runtime/stream.js";
import { getAgent, getDefaultAgent, listAgents } from "../config/agent-def.js";
import {
  addKnowledge, updateKnowledge, deleteKnowledge, getKnowledge,
  listKnowledge, buildSystemPrompt, bulkSetup,
  setSecret, deleteSecret, listSecretKeys, hasSecret,
} from "../config/knowledge.js";
import {
  registerTool, updateTool, deleteTool, getTool,
  listTools, buildDynamicTools,
} from "../config/tool-store.js";
import {
  getEnabledBuiltins, listBuiltins, enableBuiltin, disableBuiltin,
} from "../tools/builtins/index.js";
import { getSessionStore } from "../session/index.js";
import type { SessionData } from "../session/store.js";
import { AgentRequestSchema, type AgentRequestBody } from "./validation.js";

export const app = new Hono();

const DEFAULT_PROVIDER = process.env.DEFAULT_PROVIDER ?? "openai";
const DEFAULT_MODEL = process.env.DEFAULT_MODEL;

// CORS
app.use("/api/*", cors({
  origin: (origin) => {
    const allowed = process.env.CORS_ORIGIN;
    if (allowed) return allowed.split(",").includes(origin) ? origin : "";
    if (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:")) {
      return origin;
    }
    return "";
  },
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
}));

// ── Shared resolution ──

async function resolveRequest(data: AgentRequestBody, agentDef: AgentDef) {
  const provider = data.provider ?? agentDef.provider ?? DEFAULT_PROVIDER;
  const modelId = data.model ?? agentDef.model ?? DEFAULT_MODEL;
  if (!modelId) {
    return { error: "No model configured. Set DEFAULT_MODEL in .env" } as const;
  }

  let model;
  try {
    model = getModel(provider as any, modelId as any);
  } catch {
    return { error: `Unknown model: ${provider}/${modelId}` } as const;
  }

  const store = getSessionStore();
  const userId = data.userId;
  let session: SessionData | null = null;
  const currentKey = data.sessionKey ?? randomUUID();

  if (data.sessionKey) {
    session = await store.load(data.sessionKey, userId);
    if (!session) {
      return { error: `Session not found: ${data.sessionKey}` } as const;
    }
  }

  const maxTurns = data.maxTurns ?? agentDef.maxTurns ?? (Number(process.env.MAX_TURNS) || 10);

  // Merge all tool sources: config + dynamic + builtins
  const allTools = [
    ...agentDef.tools,
    ...buildDynamicTools(agentDef.name),
    ...getEnabledBuiltins({ userId, sessionKey: currentKey }),
  ];

  return { model, session, currentKey, maxTurns, userId, allTools } as const;
}

function resolveAgent(data: AgentRequestBody) {
  const agentDef = data.agent ? getAgent(data.agent) : getDefaultAgent();
  if (!agentDef) {
    const available = listAgents();
    return {
      error: data.agent
        ? `Unknown agent: "${data.agent}". Available: ${available.join(", ")}`
        : `No agents configured. Define agents in clawless.config.ts`,
    } as const;
  }
  return agentDef;
}

async function saveSession(
  currentKey: string, userId: string, agentName: string,
  messages: any[], existingSession: SessionData | null
) {
  const store = getSessionStore();
  await store.save({
    id: currentKey,
    userId,
    toolSet: agentName,
    messages,
    createdAt: existingSession?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  });
}

// ── Health ──

app.get("/api/health", (c) => {
  return c.json({
    status: "ok",
    agents: listAgents(),
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
});

// ── Agent (non-streaming) ──

app.post("/api/agent", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const parsed = AgentRequestSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 400);

  const agentDef = resolveAgent(parsed.data);
  if ("error" in agentDef) return c.json(agentDef, 400);

  const resolved = await resolveRequest(parsed.data, agentDef);
  if ("error" in resolved) return c.json(resolved, 400);

  const { model, session, currentKey, maxTurns, userId, allTools } = resolved;
  const timeoutMs = Number(process.env.TIMEOUT_MS) || 120_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await runAgent(parsed.data.prompt, {
      model,
      systemPrompt: buildSystemPrompt(agentDef.instructions, agentDef.name),
      tools: allTools,
      messages: session?.messages,
      maxTurns,
      signal: controller.signal,
    });

    await saveSession(currentKey, userId, agentDef.name, result.messages, session);

    return c.json({
      sessionKey: currentKey,
      agent: agentDef.name,
      result: result.result,
      toolCalls: result.toolCalls,
      usage: result.usage,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (controller.signal.aborted) {
      return c.json({ error: "Request timed out", details: message }, 504);
    }
    return c.json({ error: "Agent execution failed", details: message }, 500);
  } finally {
    clearTimeout(timeout);
  }
});

// ── Agent (streaming SSE) ──

app.post("/api/agent/stream", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const parsed = AgentRequestSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 400);

  const agentDef = resolveAgent(parsed.data);
  if ("error" in agentDef) return c.json(agentDef, 400);

  const resolved = await resolveRequest(parsed.data, agentDef);
  if ("error" in resolved) return c.json(resolved, 400);

  const { model, session, currentKey, maxTurns, userId, allTools } = resolved;
  const timeoutMs = Number(process.env.TIMEOUT_MS) || 120_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  return streamSSE(c, async (stream) => {
    try {
      const events = runAgentStream(parsed.data.prompt, {
        model,
        systemPrompt: buildSystemPrompt(agentDef.instructions, agentDef.name),
        tools: allTools,
        messages: session?.messages,
        maxTurns,
        signal: controller.signal,
        sessionId: currentKey,
      });

      let returnValue: Awaited<ReturnType<typeof events.next>> | undefined;
      while (true) {
        returnValue = await events.next();
        if (returnValue.done) break;
        const sseEvent = returnValue.value;
        await stream.writeSSE({
          event: sseEvent.event,
          data: "data" in sseEvent ? JSON.stringify(sseEvent.data) : "{}",
        });
      }

      const messages = returnValue?.value;
      if (messages && messages.length > 0) {
        await saveSession(currentKey, userId, agentDef.name, messages, session);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ message }),
      });
    } finally {
      clearTimeout(timeout);
    }
  });
});

// ── Sessions ──

app.get("/api/sessions", async (c) => {
  const userId = c.req.query("userId");
  if (!userId) return c.json({ error: "userId query param required" }, 400);
  const store = getSessionStore();
  const sessions = await store.list(userId);
  return c.json({ sessions });
});

app.get("/api/sessions/:id", async (c) => {
  const userId = c.req.query("userId");
  if (!userId) return c.json({ error: "userId query param required" }, 400);
  const store = getSessionStore();
  const session = await store.load(c.req.param("id"), userId);
  if (!session) return c.json({ error: "Session not found" }, 404);
  return c.json({
    id: session.id,
    agent: session.toolSet,
    messageCount: session.messages.length,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  });
});

app.delete("/api/sessions/:id", async (c) => {
  const userId = c.req.query("userId");
  if (!userId) return c.json({ error: "userId query param required" }, 400);
  const store = getSessionStore();
  await store.delete(c.req.param("id"), userId);
  return c.json({ ok: true });
});

// ── Bulk setup ──

app.post("/api/setup", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const defaultAgent = listAgents()[0] ?? "default";

  if (body.knowledge) {
    for (const item of body.knowledge) {
      if (!item.agent) item.agent = defaultAgent;
    }
  }

  const knowledgeResults = bulkSetup(body);

  // Tools
  const toolResults: Array<{ name: string; ok: boolean; error?: string }> = [];
  if (body.tools && Array.isArray(body.tools)) {
    for (const toolDef of body.tools) {
      const result = registerTool(toolDef, defaultAgent);
      if (result.ok) {
        toolResults.push({ name: result.tool.name, ok: true });
      } else {
        toolResults.push({ name: toolDef.name ?? "unknown", ok: false, error: result.error });
      }
    }
  }

  // Builtins toggle
  const builtinResults: Array<{ name: string; ok: boolean }> = [];
  if (body.builtins && Array.isArray(body.builtins)) {
    for (const name of body.builtins) {
      builtinResults.push({ name, ok: enableBuiltin(name) });
    }
  }

  const allResults = {
    ...knowledgeResults,
    tools: toolResults,
    builtins: builtinResults,
  };

  const hasErrors =
    knowledgeResults.knowledge.some((r) => !r.ok) ||
    knowledgeResults.secrets.some((r) => !r.ok) ||
    toolResults.some((r) => !r.ok);

  return c.json(allResults, hasErrors ? 207 : 201);
});

// ── Knowledge ──

app.post("/api/knowledge", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const agent = body.agent ?? listAgents()[0] ?? "default";
  const result = addKnowledge({ ...body, agent });
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json(result.item, 201);
});

app.get("/api/knowledge", (c) => {
  const agent = c.req.query("agent");
  return c.json({ items: listKnowledge(agent ?? undefined) });
});

app.get("/api/knowledge/:id", (c) => {
  const item = getKnowledge(c.req.param("id"));
  if (!item) return c.json({ error: "Not found" }, 404);
  return c.json(item);
});

app.put("/api/knowledge/:id", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const updated = updateKnowledge(c.req.param("id"), body);
  if (!updated) return c.json({ error: "Not found or would exceed size limit" }, 400);
  return c.json(updated);
});

app.delete("/api/knowledge/:id", (c) => {
  deleteKnowledge(c.req.param("id"));
  return c.json({ ok: true });
});

// ── Secrets ──

app.post("/api/secrets", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const result = setSecret(body.key, body.value, body.expiresAt);
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json({ ok: true, key: body.key }, 201);
});

app.get("/api/secrets", (c) => {
  return c.json({ keys: listSecretKeys() });
});

app.get("/api/secrets/:key", (c) => {
  return c.json({ key: c.req.param("key"), exists: hasSecret(c.req.param("key")) });
});

app.delete("/api/secrets/:key", (c) => {
  deleteSecret(c.req.param("key"));
  return c.json({ ok: true });
});

// ── Tools ──

app.post("/api/tools", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const agent = body.agent ?? listAgents()[0] ?? "default";
  const result = registerTool(body, agent);
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json(result.tool, 201);
});

app.get("/api/tools", (c) => {
  const agent = c.req.query("agent");
  return c.json({ tools: listTools(agent ?? undefined) });
});

app.get("/api/tools/:name", (c) => {
  const tool = getTool(c.req.param("name"));
  if (!tool) return c.json({ error: "Not found" }, 404);
  return c.json(tool);
});

app.put("/api/tools/:name", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const updated = updateTool(c.req.param("name"), body);
  if (!updated) return c.json({ error: "Not found" }, 404);
  return c.json(updated);
});

app.delete("/api/tools/:name", (c) => {
  deleteTool(c.req.param("name"));
  return c.json({ ok: true });
});

// ── Builtins ──

app.get("/api/builtins", (c) => {
  return c.json({ builtins: listBuiltins() });
});

app.post("/api/builtins/:name/enable", (c) => {
  const ok = enableBuiltin(c.req.param("name"));
  if (!ok) return c.json({ error: "Unknown builtin" }, 404);
  return c.json({ ok: true, name: c.req.param("name"), enabled: true });
});

app.post("/api/builtins/:name/disable", (c) => {
  const ok = disableBuiltin(c.req.param("name"));
  if (!ok) return c.json({ error: "Unknown builtin" }, 404);
  return c.json({ ok: true, name: c.req.param("name"), enabled: false });
});
