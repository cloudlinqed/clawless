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
import { getSessionStore } from "../session/index.js";
import type { SessionData } from "../session/store.js";
import { AgentRequestSchema, type AgentRequestBody } from "./validation.js";

export const app = new Hono();

const DEFAULT_PROVIDER = process.env.DEFAULT_PROVIDER ?? "openai";
const DEFAULT_MODEL = process.env.DEFAULT_MODEL;

// CORS — allow Vite dev server and any configured origins
app.use("/api/*", cors({
  origin: (origin) => {
    const allowed = process.env.CORS_ORIGIN;
    if (allowed) return allowed.split(",").includes(origin) ? origin : "";
    if (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:")) {
      return origin;
    }
    return "";
  },
  allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
}));

// Shared resolution for both endpoints
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
  let session: SessionData | null = null;
  const currentKey = data.sessionKey ?? randomUUID();

  if (data.sessionKey) {
    session = await store.load(data.sessionKey);
    if (!session) {
      return { error: `Session not found: ${data.sessionKey}` } as const;
    }
  }

  const maxTurns = data.maxTurns ?? agentDef.maxTurns ?? (Number(process.env.MAX_TURNS) || 10);

  return { model, session, currentKey, maxTurns } as const;
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

// Health check
app.get("/api/health", (c) => {
  return c.json({ status: "ok", agents: listAgents(), defaultProvider: DEFAULT_PROVIDER, defaultModel: DEFAULT_MODEL });
});

// Main agent endpoint
app.post("/api/agent", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const parsed = AgentRequestSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 400);

  const agentDef = resolveAgent(parsed.data);
  if ("error" in agentDef) return c.json(agentDef, 400);

  const resolved = await resolveRequest(parsed.data, agentDef);
  if ("error" in resolved) return c.json(resolved, 400);

  const { model, session, currentKey, maxTurns } = resolved;
  const timeoutMs = Number(process.env.TIMEOUT_MS) || 120_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await runAgent(parsed.data.prompt, {
      model,
      systemPrompt: buildSystemPrompt(agentDef.instructions, agentDef.name),
      tools: agentDef.tools,
      messages: session?.messages,
      maxTurns,
      signal: controller.signal,
    });

    const store = getSessionStore();
    await store.save({
      id: currentKey,
      toolSet: agentDef.name,
      messages: result.messages,
      createdAt: session?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    });

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

// Streaming agent endpoint — SSE
app.post("/api/agent/stream", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const parsed = AgentRequestSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 400);

  const agentDef = resolveAgent(parsed.data);
  if ("error" in agentDef) return c.json(agentDef, 400);

  const resolved = await resolveRequest(parsed.data, agentDef);
  if ("error" in resolved) return c.json(resolved, 400);

  const { model, session, currentKey, maxTurns } = resolved;
  const timeoutMs = Number(process.env.TIMEOUT_MS) || 120_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  return streamSSE(c, async (stream) => {
    try {
      const events = runAgentStream(parsed.data.prompt, {
        model,
        systemPrompt: buildSystemPrompt(agentDef.instructions, agentDef.name),
        tools: agentDef.tools,
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

      // Save session — messages returned from the generator
      const messages = returnValue?.value;
      if (messages && messages.length > 0) {
        const store = getSessionStore();
        await store.save({
          id: currentKey,
          toolSet: agentDef.name,
          messages,
          createdAt: session?.createdAt ?? Date.now(),
          updatedAt: Date.now(),
        });
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

// Get session history
app.get("/api/sessions/:id", async (c) => {
  const store = getSessionStore();
  const session = await store.load(c.req.param("id"));
  if (!session) return c.json({ error: "Session not found" }, 404);
  return c.json({
    id: session.id,
    agent: session.toolSet,
    messageCount: session.messages.length,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  });
});

// Delete session
app.delete("/api/sessions/:id", async (c) => {
  const store = getSessionStore();
  await store.delete(c.req.param("id"));
  return c.json({ ok: true });
});

// List sessions
app.get("/api/sessions", async (c) => {
  const store = getSessionStore();
  const sessions = await store.list();
  return c.json({ sessions });
});

// ── Bulk setup ──
// Single call to configure knowledge + secrets. Ideal for frontend onboarding.
app.post("/api/setup", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  // Default agent name for knowledge items that don't specify one
  const defaultAgent = listAgents()[0] ?? "default";
  if (body.knowledge) {
    for (const item of body.knowledge) {
      if (!item.agent) item.agent = defaultAgent;
    }
  }

  const results = bulkSetup(body);
  const hasErrors = results.knowledge.some((r) => !r.ok) || results.secrets.some((r) => !r.ok);
  return c.json(results, hasErrors ? 207 : 201);
});

// ── Knowledge API ──

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

// ── Secrets API ──

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
