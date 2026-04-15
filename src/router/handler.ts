import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { getModel, getProviders, getModels, getEnvApiKey } from "@mariozechner/pi-ai";
import type { AgentDef } from "../config/agent-def.js";
import { initializeClawless } from "../bootstrap.js";
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
import { createRequestContext, runWithRequestContext } from "../runtime/request-context.js";
import { getOutOfScopeMessage, evaluatePromptScope } from "../security/scope.js";
import { requireAdminAccess, resolveEffectiveUserId } from "../auth/index.js";
import { AgentRequestSchema, type AgentRequestBody } from "./validation.js";

export const app = new Hono();

const DEFAULT_PROVIDER = process.env.DEFAULT_PROVIDER ?? "openai";
const DEFAULT_MODEL = process.env.DEFAULT_MODEL;
const DEFAULT_FALLBACKS = process.env.DEFAULT_FALLBACK_MODELS
  ? process.env.DEFAULT_FALLBACK_MODELS.split(",").map((s) => s.trim())
  : [];

/**
 * Parse a model spec into provider + modelId.
 * Formats: "provider/modelId" or just "modelId" (inherits provider).
 */
function parseModelSpec(spec: string, defaultProvider: string): { provider: string; modelId: string } {
  if (spec.includes("/")) {
    const [provider, ...rest] = spec.split("/");
    return { provider, modelId: rest.join("/") };
  }
  return { provider: defaultProvider, modelId: spec };
}

/**
 * Build ordered model chain: primary + fallbacks.
 * Returns resolved Model objects. Skips invalid entries.
 */
function resolveModelChain(
  primaryProvider: string,
  primaryModelId: string,
  fallbacks: string[]
): Array<{ model: ReturnType<typeof getModel>; label: string }> {
  const chain: Array<{ model: ReturnType<typeof getModel>; label: string }> = [];

  try {
    chain.push({
      model: getModel(primaryProvider as any, primaryModelId as any),
      label: `${primaryProvider}/${primaryModelId}`,
    });
  } catch {
    // Primary invalid — still try fallbacks
  }

  for (const spec of fallbacks) {
    const { provider, modelId } = parseModelSpec(spec, primaryProvider);
    try {
      chain.push({
        model: getModel(provider as any, modelId as any),
        label: `${provider}/${modelId}`,
      });
    } catch {
      // Skip invalid fallback
    }
  }

  return chain;
}

/**
 * Check if an error should trigger model fallback.
 * Only abort-related errors (user cancelled, timeout) skip fallback.
 * Everything else — rate limits, auth, model not found, server errors — tries the next model.
 */
function shouldFallback(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.toLowerCase().includes("aborted")) return false;
  return true;
}

// CORS
app.use("/api/*", cors({
  origin: (origin) => {
    if (!origin) return "";
    const allowed = process.env.CORS_ORIGIN;
    if (allowed) return allowed.split(",").includes(origin) ? origin : "";
    if (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:")) {
      return origin;
    }
    return "";
  },
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: [
    "Content-Type",
    "Authorization",
    process.env.ADMIN_API_KEY_HEADER ?? "x-clawless-admin-key",
    process.env.AUTH_TRUSTED_USER_HEADER ?? "",
  ].filter(Boolean),
}));

app.use("/api/*", async (c, next) => {
  try {
    await initializeClawless();
    await next();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "Failed to initialize Clawless", details: message }, 500);
  }
});

// ── Shared resolution ──

function filterBuiltinsForAgent(agentDef: AgentDef) {
  const builtins = getEnabledBuiltins();
  const policy = agentDef.builtinPolicy;

  let filtered = builtins;

  if (policy?.allow && policy.allow.length > 0) {
    const allowed = new Set(policy.allow);
    filtered = filtered.filter((tool) => allowed.has(tool.name));
  }

  if (policy?.deny && policy.deny.length > 0) {
    const denied = new Set(policy.deny);
    filtered = filtered.filter((tool) => !denied.has(tool.name));
  }

  return filtered;
}

async function resolveRequest(userId: string, data: AgentRequestBody, agentDef: AgentDef) {
  const provider = data.provider ?? agentDef.provider ?? DEFAULT_PROVIDER;
  const modelId = data.model ?? agentDef.model ?? DEFAULT_MODEL;
  if (!modelId) {
    return { error: "No model configured. Set DEFAULT_MODEL in .env" } as const;
  }

  // Build model chain: primary + fallbacks
  const fallbacks = data.fallbackModels ?? agentDef.fallbackModels ?? DEFAULT_FALLBACKS;
  const modelChain = resolveModelChain(provider, modelId, fallbacks);
  if (modelChain.length === 0) {
    return { error: `No valid models found. Primary: ${provider}/${modelId}` } as const;
  }

  const store = getSessionStore();
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
    ...filterBuiltinsForAgent(agentDef),
  ];

  return { modelChain, session, currentKey, maxTurns, userId, allTools } as const;
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

async function enforceRequestScope(
  prompt: string,
  agentDef: AgentDef,
  modelChain: Array<{ model: ReturnType<typeof getModel>; label: string }>,
  signal?: AbortSignal
): Promise<{ allowed: boolean; label: string }> {
  let lastError: unknown;
  let usedLabel = modelChain[0]?.label ?? "unknown";

  for (const { model, label } of modelChain) {
    usedLabel = label;
    try {
      const verdict = await evaluatePromptScope(prompt, agentDef, model, signal);
      return { allowed: verdict.allowed, label };
    } catch (err) {
      lastError = err;
      if (!shouldFallback(err, signal)) break;
    }
  }

  throw lastError ?? new Error("Failed to evaluate request scope");
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
  return c.json({ status: "ok" });
});

// ── Providers ──
// List available AI providers and their models.

const PROVIDER_ENV_MAP: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
  "google-vertex": "GOOGLE_CLOUD_API_KEY",
  "amazon-bedrock": "AWS_ACCESS_KEY_ID",
  "azure-openai-responses": "AZURE_OPENAI_API_KEY",
  groq: "GROQ_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  xai: "XAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  mistral: "MISTRAL_API_KEY",
};

app.get("/api/providers", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  const providers = getProviders()
    .filter((p) => !["google-gemini-cli", "google-antigravity", "openai-codex", "github-copilot", "opencode", "opencode-go", "kimi-coding", "minimax", "minimax-cn", "huggingface", "zai", "vercel-ai-gateway"].includes(p))
    .map((provider) => {
      const models = getModels(provider as any).map((m) => ({
        id: m.id,
        name: m.name,
        reasoning: m.reasoning,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        input: m.input,
      }));

      const envVar = PROVIDER_ENV_MAP[provider];
      const configured = !!getEnvApiKey(provider);

      return { provider, envVar, configured, models };
    });

  return c.json({ providers });
});

app.get("/api/providers/:provider/models", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  const provider = c.req.param("provider");
  try {
    const models = getModels(provider as any).map((m) => ({
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      input: m.input,
      cost: m.cost,
    }));
    const configured = !!getEnvApiKey(provider);
    return c.json({ provider, configured, models });
  } catch {
    return c.json({ error: `Unknown provider: ${provider}` }, 404);
  }
});

// ── Capabilities ──
// Single view of everything the agent can do.

app.get("/api/capabilities", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  const agentName = c.req.query("agent");
  const agentDef = agentName ? getAgent(agentName) : getDefaultAgent();

  const configTools = agentDef
    ? agentDef.tools.map((t) => ({ name: t.name, source: "config", description: t.description }))
    : [];

  const dynamicTools = listTools(agentName ?? undefined).map((t) => ({
    name: t.name,
    source: "dynamic",
    description: t.description,
    url: t.url,
  }));

  const builtins = listBuiltins().map((b) => ({
    name: b.name,
    source: "builtin",
    enabled: b.enabled,
    description: b.description,
  }));

  const knowledge = listKnowledge(agentName ?? undefined).map((k) => ({
    id: k.id,
    title: k.title,
    priority: k.priority,
    contentLength: k.content.length,
  }));

  const secrets = listSecretKeys().map((s) => ({
    key: s.key,
    expired: s.expired,
  }));

  return c.json({
    agent: agentDef?.name ?? null,
    tools: [...configTools, ...dynamicTools, ...builtins],
    knowledge,
    secrets,
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

  const identity = await resolveEffectiveUserId(c, parsed.data.userId);
  if (!identity.ok) return c.json({ error: identity.error }, identity.status);

  const resolved = await resolveRequest(identity.userId, parsed.data, agentDef);
  if ("error" in resolved) return c.json(resolved, 400);

  const { modelChain, session, currentKey, maxTurns, userId, allTools } = resolved;
  const requestContext = createRequestContext({
    userId,
    sessionKey: currentKey,
    agentName: agentDef.name,
    auth: identity.auth,
  });
  const timeoutMs = Number(process.env.TIMEOUT_MS) || 120_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let scope: { allowed: boolean; label: string };
    try {
      scope = await enforceRequestScope(parsed.data.prompt, agentDef, modelChain, controller.signal);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (controller.signal.aborted) {
        return c.json({ error: "Request timed out", details: message }, 504);
      }
      return c.json({ error: "Failed to evaluate request scope", details: message }, 500);
    }

    if (!scope.allowed) {
      return c.json({
        sessionKey: currentKey,
        agent: agentDef.name,
        model: scope.label,
        result: getOutOfScopeMessage(agentDef),
        toolCalls: [],
        usage: {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalTokens: 0,
          turns: 0,
        },
      });
    }

    let lastError: unknown;
    let usedModel = modelChain[0].label;

    for (const { model, label } of modelChain) {
      try {
        const result = await runWithRequestContext(requestContext, () => runAgent(parsed.data.prompt, {
          model,
          systemPrompt: buildSystemPrompt(agentDef),
          tools: allTools,
          messages: session?.messages,
          maxTurns,
          signal: controller.signal,
        }));

        await saveSession(currentKey, userId, agentDef.name, result.messages, session);

        return c.json({
          sessionKey: currentKey,
          agent: agentDef.name,
          model: label,
          result: result.result,
          toolCalls: result.toolCalls,
          usage: result.usage,
        });
      } catch (err) {
        lastError = err;
        usedModel = label;
        if (!shouldFallback(err, controller.signal)) break;
        // Retryable — try next model in chain
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError);
    if (controller.signal.aborted) {
      return c.json({ error: "Request timed out", details: message }, 504);
    }
    return c.json({ error: "Agent execution failed", model: usedModel, details: message }, 500);
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

  const identity = await resolveEffectiveUserId(c, parsed.data.userId);
  if (!identity.ok) return c.json({ error: identity.error }, identity.status);

  const resolved = await resolveRequest(identity.userId, parsed.data, agentDef);
  if ("error" in resolved) return c.json(resolved, 400);

  const { modelChain, session, currentKey, maxTurns, userId, allTools } = resolved;
  const requestContext = createRequestContext({
    userId,
    sessionKey: currentKey,
    agentName: agentDef.name,
    auth: identity.auth,
  });
  const timeoutMs = Number(process.env.TIMEOUT_MS) || 120_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let scope: { allowed: boolean; label: string };
  try {
    scope = await enforceRequestScope(parsed.data.prompt, agentDef, modelChain, controller.signal);
  } catch (err) {
    clearTimeout(timeout);
    const message = err instanceof Error ? err.message : String(err);
    if (controller.signal.aborted) {
      return c.json({ error: "Request timed out", details: message }, 504);
    }
    return c.json({ error: "Failed to evaluate request scope", details: message }, 500);
  }

  if (!scope.allowed) {
    const refusal = getOutOfScopeMessage(agentDef);
    return streamSSE(c, async (stream) => {
      try {
        await stream.writeSSE({
          event: "model_selected",
          data: JSON.stringify({ model: scope.label }),
        });
        await stream.writeSSE({ event: "agent_start", data: "{}" });
        await stream.writeSSE({
          event: "turn_start",
          data: JSON.stringify({ turn: 1 }),
        });
        await stream.writeSSE({
          event: "text_done",
          data: JSON.stringify({ text: refusal }),
        });
        await stream.writeSSE({
          event: "turn_end",
          data: JSON.stringify({ turn: 1 }),
        });
        await stream.writeSSE({
          event: "agent_end",
          data: JSON.stringify({
            sessionKey: currentKey,
            result: refusal,
            toolCalls: [],
            usage: {
              totalInputTokens: 0,
              totalOutputTokens: 0,
              totalTokens: 0,
              turns: 1,
            },
          }),
        });
      } finally {
        clearTimeout(timeout);
      }
    });
  }

  return streamSSE(c, async (stream) => runWithRequestContext(requestContext, async () => {
    try {
      for (let i = 0; i < modelChain.length; i++) {
        const { model, label } = modelChain[i];
        const isLast = i === modelChain.length - 1;

        await stream.writeSSE({
          event: "model_selected",
          data: JSON.stringify({ model: label }),
        });

        const events = runAgentStream(parsed.data.prompt, {
          model,
          systemPrompt: buildSystemPrompt(agentDef),
          tools: allTools,
          messages: session?.messages,
          maxTurns,
          signal: controller.signal,
          sessionId: currentKey,
        });

        // Consume the stream, detect errors, decide whether to fallback
        let hadError = false;
        let errorMessage = "";
        const bufferedEvents: Array<{ event: string; data: string }> = [];

        let returnValue: Awaited<ReturnType<typeof events.next>> | undefined;
        while (true) {
          returnValue = await events.next();
          if (returnValue.done) break;
          const sseEvent = returnValue.value;

          // Check for error events — if we have fallbacks left, don't write yet
          if (sseEvent.event === "error" && !isLast) {
            hadError = true;
            errorMessage = "data" in sseEvent ? (sseEvent.data as any).message ?? "" : "";
            // Drain remaining events (agent_end) without writing
            while (true) {
              const r = await events.next();
              if (r.done) { returnValue = r; break; }
            }
            break;
          }

          // Buffer early events (agent_start, turn_start) on non-last models
          // so we can discard them if this model fails
          if (!isLast && sseEvent.event !== "text_delta" && sseEvent.event !== "tool_start" && sseEvent.event !== "tool_end" && bufferedEvents.length < 5 && !hadError) {
            bufferedEvents.push({
              event: sseEvent.event,
              data: "data" in sseEvent ? JSON.stringify(sseEvent.data) : "{}",
            });
          } else {
            // Flush buffer first
            for (const be of bufferedEvents) {
              await stream.writeSSE(be);
            }
            bufferedEvents.length = 0;

            await stream.writeSSE({
              event: sseEvent.event,
              data: "data" in sseEvent ? JSON.stringify(sseEvent.data) : "{}",
            });
          }
        }

        if (hadError && !isLast && shouldFallback(new Error(errorMessage), controller.signal)) {
          await stream.writeSSE({
            event: "model_fallback",
            data: JSON.stringify({ failed: label, reason: errorMessage }),
          });
          continue; // Try next model
        }

        // Success or last model — flush any remaining buffer
        for (const be of bufferedEvents) {
          await stream.writeSSE(be);
        }

        // Save session
        const messages = returnValue?.value;
        if (messages && messages.length > 0) {
          await saveSession(currentKey, userId, agentDef.name, messages, session);
        }
        return;
      }
    } finally {
      clearTimeout(timeout);
    }
  }));
});

// ── Sessions ──

app.get("/api/sessions", async (c) => {
  const identity = await resolveEffectiveUserId(c, c.req.query("userId") ?? undefined);
  if (!identity.ok) return c.json({ error: identity.error }, identity.status);
  const store = getSessionStore();
  const sessions = await store.list(identity.userId);
  return c.json({ sessions });
});

app.get("/api/sessions/:id", async (c) => {
  const identity = await resolveEffectiveUserId(c, c.req.query("userId") ?? undefined);
  if (!identity.ok) return c.json({ error: identity.error }, identity.status);
  const store = getSessionStore();
  const session = await store.load(c.req.param("id"), identity.userId);
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
  const identity = await resolveEffectiveUserId(c, c.req.query("userId") ?? undefined);
  if (!identity.ok) return c.json({ error: identity.error }, identity.status);
  const store = getSessionStore();
  await store.delete(c.req.param("id"), identity.userId);
  return c.json({ ok: true });
});

// ── Bulk setup ──

app.post("/api/setup", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

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
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const agent = body.agent ?? listAgents()[0] ?? "default";
  const result = addKnowledge({ ...body, agent });
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json(result.item, 201);
});

app.get("/api/knowledge", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  const agent = c.req.query("agent");
  return c.json({ items: listKnowledge(agent ?? undefined) });
});

app.get("/api/knowledge/:id", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  const item = getKnowledge(c.req.param("id"));
  if (!item) return c.json({ error: "Not found" }, 404);
  return c.json(item);
});

app.put("/api/knowledge/:id", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const updated = updateKnowledge(c.req.param("id"), body);
  if (!updated) return c.json({ error: "Not found or would exceed size limit" }, 400);
  return c.json(updated);
});

app.delete("/api/knowledge/:id", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  deleteKnowledge(c.req.param("id"));
  return c.json({ ok: true });
});

// ── Secrets ──

app.post("/api/secrets", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const result = setSecret(body.key, body.value, body.expiresAt);
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json({ ok: true, key: body.key }, 201);
});

app.get("/api/secrets", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  return c.json({ keys: listSecretKeys() });
});

app.get("/api/secrets/:key", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  return c.json({ key: c.req.param("key"), exists: hasSecret(c.req.param("key")) });
});

app.delete("/api/secrets/:key", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  deleteSecret(c.req.param("key"));
  return c.json({ ok: true });
});

// ── Tools ──

app.post("/api/tools", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const agent = body.agent ?? listAgents()[0] ?? "default";
  const result = registerTool(body, agent);
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json(result.tool, 201);
});

app.get("/api/tools", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  const agent = c.req.query("agent");
  return c.json({ tools: listTools(agent ?? undefined) });
});

app.get("/api/tools/:name", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  const tool = getTool(c.req.param("name"));
  if (!tool) return c.json({ error: "Not found" }, 404);
  return c.json(tool);
});

app.put("/api/tools/:name", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const updated = updateTool(c.req.param("name"), body);
  if (!updated) return c.json({ error: "Not found" }, 404);
  return c.json(updated);
});

app.delete("/api/tools/:name", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  deleteTool(c.req.param("name"));
  return c.json({ ok: true });
});

// ── Builtins ──

app.get("/api/builtins", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  return c.json({ builtins: listBuiltins() });
});

app.post("/api/builtins/:name/enable", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  const ok = enableBuiltin(c.req.param("name"));
  if (!ok) return c.json({ error: "Unknown builtin" }, 404);
  return c.json({ ok: true, name: c.req.param("name"), enabled: true });
});

app.post("/api/builtins/:name/disable", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  const ok = disableBuiltin(c.req.param("name"));
  if (!ok) return c.json({ error: "Unknown builtin" }, 404);
  return c.json({ ok: true, name: c.req.param("name"), enabled: false });
});
