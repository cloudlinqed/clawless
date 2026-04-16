import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { getModel, getProviders, getModels, getEnvApiKey } from "@mariozechner/pi-ai";
import type { AgentDef } from "../config/agent-def.js";
import { initializeClawless } from "../bootstrap.js";
import { runAgent } from "../runtime/agent.js";
import { runAgentStream } from "../runtime/stream.js";
import {
  deleteRuntimeAgentConfig,
  deleteRuntimeAgentConfigFor,
  getAgent,
  getAgentFor,
  getDefaultAgent,
  getDefaultAgentFor,
  getRuntimeAgentConfig,
  listAgents,
  listRuntimeAgentConfigsFor,
  upsertRuntimeAgentConfig,
} from "../config/agent-def.js";
import {
  getConfigStatus,
  getRuntimeConfigEnvironment,
  getRuntimeConfigStage,
  listConfigEnvironments,
  listConfigReleases,
  promoteConfig,
  publishDraft,
  rollbackConfig,
  type ConfigStage,
} from "../config/lifecycle.js";
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
import { StructuredOutputContractError } from "../output/postprocess.js";
import { buildStructuredOutputTool } from "../output/tool.js";
import { getAllowedOutputBlocks, getOutputSchemaMode } from "../output/schema.js";
import { retrieveAgentContext } from "../retrieval/index.js";
import { listRetrievers, type RetrievedDocument } from "../retrieval/registry.js";
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

function parseConfigStage(value?: string | null): ConfigStage | undefined {
  if (value === "draft" || value === "published") {
    return value;
  }
  return undefined;
}

function resolveConfigEnvironment(c: any, body?: Record<string, unknown>): string | undefined {
  const queryValue = c.req.query("environment");
  if (queryValue) return queryValue;
  const bodyValue = typeof body?.environment === "string" ? body.environment : undefined;
  return bodyValue;
}

function resolveConfigStage(c: any, body?: Record<string, unknown>): ConfigStage | undefined {
  return parseConfigStage(c.req.query("stage")) ?? parseConfigStage(typeof body?.stage === "string" ? body.stage : undefined);
}

function serializeRetrievalConfig(agentDef: AgentDef | undefined) {
  if (!agentDef?.retrieval) return null;
  return {
    mode: agentDef.retrieval.mode ?? "off",
    topK: agentDef.retrieval.topK ?? 6,
    maxChars: agentDef.retrieval.maxChars ?? 6000,
    instructions: agentDef.retrieval.instructions,
    sources: agentDef.retrieval.sources ?? [{ type: "knowledge" }],
  };
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

function buildGeneratedTools(agentDef: AgentDef) {
  const tools = [];
  const outputTool = buildStructuredOutputTool(agentDef);
  if (outputTool) {
    tools.push(outputTool);
  }
  return tools;
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
    ...buildGeneratedTools(agentDef),
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

app.get("/api/retrievers", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  return c.json({ retrievers: listRetrievers() });
});

// ── Capabilities ──
// Single view of everything the agent can do.

app.get("/api/capabilities", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  const agentName = c.req.query("agent");
  const environment = resolveConfigEnvironment(c);
  const stage = resolveConfigStage(c);
  const agentDef = agentName
    ? getAgentFor(agentName, { environment, stage })
    : getDefaultAgentFor({ environment, stage });

  const configTools = agentDef
    ? agentDef.tools.map((t) => ({ name: t.name, source: "config", description: t.description }))
    : [];

  const generatedTools = agentDef
    ? buildGeneratedTools(agentDef).map((t) => ({ name: t.name, source: "generated", description: t.description }))
    : [];

  const dynamicTools = listTools(agentName ?? undefined, { environment, stage }).map((t) => ({
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

  const knowledge = listKnowledge(agentName ?? undefined, { environment, stage }).map((k) => ({
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
    environment: environment ?? getRuntimeConfigEnvironment(),
    stage: stage ?? getRuntimeConfigStage(),
    agent: agentDef?.name ?? null,
    tools: [...configTools, ...generatedTools, ...dynamicTools, ...builtins],
    outputSchema: agentDef?.outputSchema
      ? {
          mode: getOutputSchemaMode(agentDef.outputSchema),
          allowedBlocks: getAllowedOutputBlocks(agentDef.outputSchema),
          preferredBlocks: agentDef.outputSchema.preferredBlocks ?? [],
          requiredBlocks: agentDef.outputSchema.requiredBlocks ?? [],
          requireCitations: agentDef.outputSchema.requireCitations ?? false,
          onInvalid: agentDef.outputSchema.onInvalid ?? (getOutputSchemaMode(agentDef.outputSchema) === "required" ? "reject" : "repair"),
        }
      : null,
    retrieval: serializeRetrievalConfig(agentDef),
    retrievers: listRetrievers(),
    knowledge,
    secrets,
    config: getConfigStatus(environment),
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
    let retrievedContext: RetrievedDocument[] = [];
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
        output: null,
        retrieval: [],
        toolCalls: [],
        usage: {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalTokens: 0,
          turns: 0,
        },
      });
    }

    retrievedContext = await retrieveAgentContext(parsed.data.prompt, agentDef, controller.signal);

    let lastError: unknown;
    let usedModel = modelChain[0].label;

    for (const { model, label } of modelChain) {
      try {
        const result = await runWithRequestContext(requestContext, () => runAgent(parsed.data.prompt, {
          model,
          systemPrompt: buildSystemPrompt(agentDef, agentDef.instructions, {
            retrievedContext,
          }),
          tools: allTools,
          outputSchema: agentDef.outputSchema,
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
          output: result.output,
          retrieval: retrievedContext,
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
    if (lastError instanceof StructuredOutputContractError) {
      return c.json({
        error: "Structured output did not satisfy the declared schema",
        details: lastError.issues,
        model: usedModel,
      }, 422);
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
  let retrievedContext: RetrievedDocument[] = [];

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
          event: "retrieval_ready",
          data: JSON.stringify({ documents: [] }),
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
            output: null,
            retrieval: [],
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

  retrievedContext = await retrieveAgentContext(parsed.data.prompt, agentDef, controller.signal);

  return streamSSE(c, async (stream) => runWithRequestContext(requestContext, async () => {
    try {
      await stream.writeSSE({
        event: "retrieval_ready",
        data: JSON.stringify({ documents: retrievedContext }),
      });

      for (let i = 0; i < modelChain.length; i++) {
        const { model, label } = modelChain[i];
        const isLast = i === modelChain.length - 1;

        await stream.writeSSE({
          event: "model_selected",
          data: JSON.stringify({ model: label }),
        });

        const events = runAgentStream(parsed.data.prompt, {
          model,
          systemPrompt: buildSystemPrompt(agentDef, agentDef.instructions, {
            retrievedContext,
          }),
          tools: allTools,
          outputSchema: agentDef.outputSchema,
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

            const payload = "data" in sseEvent ? (
              sseEvent.event === "agent_end"
                ? JSON.stringify({
                    ...sseEvent.data,
                    retrieval: retrievedContext,
                  })
                : JSON.stringify(sseEvent.data)
            ) : "{}";

            await stream.writeSSE({
              event: sseEvent.event,
              data: payload,
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
  const environment = resolveConfigEnvironment(c, body) ?? getRuntimeConfigEnvironment();

  const defaultAgent = listAgents({ environment, stage: "draft" })[0] ?? "default";

  if (body.knowledge) {
    for (const item of body.knowledge) {
      if (!item.agent) item.agent = defaultAgent;
    }
  }

  const knowledgeResults = bulkSetup(body, { environment });

  // Tools
  const toolResults: Array<{ name: string; ok: boolean; error?: string }> = [];
  if (body.tools && Array.isArray(body.tools)) {
    for (const toolDef of body.tools) {
      const result = registerTool(toolDef, defaultAgent, { environment });
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
    environment,
    ...knowledgeResults,
    tools: toolResults,
    builtins: builtinResults,
  };

  const hasErrors =
    knowledgeResults.knowledge.some((r) => !r.ok) ||
    knowledgeResults.secrets.some((r) => !r.ok) ||
    toolResults.some((r) => !r.ok);

  if (body.publish === true) {
    const release = publishDraft({
      environment,
      note: typeof body.note === "string" ? body.note : "Published from bulk setup",
    });
    return c.json({ ...allResults, release }, hasErrors ? 207 : 201);
  }

  return c.json(allResults, hasErrors ? 207 : 201);
});

// ── Agents ──

app.post("/api/agents", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const environment = resolveConfigEnvironment(c, body);
  const result = upsertRuntimeAgentConfig(body, { environment });
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json({ environment: environment ?? getRuntimeConfigEnvironment(), agent: result.agent }, 201);
});

app.get("/api/agents", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  const environment = resolveConfigEnvironment(c);
  const stage = resolveConfigStage(c);
  return c.json({
    environment: environment ?? getRuntimeConfigEnvironment(),
    stage: stage ?? getRuntimeConfigStage(),
    agents: listRuntimeAgentConfigsFor({ environment, stage }),
  });
});

app.get("/api/agents/:name", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  const environment = resolveConfigEnvironment(c);
  const stage = resolveConfigStage(c);
  const agent = getRuntimeAgentConfig(c.req.param("name"), { environment, stage });
  if (!agent) return c.json({ error: "Not found" }, 404);
  return c.json({
    environment: environment ?? getRuntimeConfigEnvironment(),
    stage: stage ?? getRuntimeConfigStage(),
    agent,
  });
});

app.put("/api/agents/:name", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const environment = resolveConfigEnvironment(c, body);
  const existing = getRuntimeAgentConfig(c.req.param("name"), { environment, stage: "draft" });
  if (!existing) return c.json({ error: "Not found" }, 404);

  const result = upsertRuntimeAgentConfig({
    ...existing,
    ...body,
    name: c.req.param("name"),
  }, { environment });

  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json(result.agent);
});

app.delete("/api/agents/:name", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  const environment = resolveConfigEnvironment(c);
  const deleted = deleteRuntimeAgentConfigFor(c.req.param("name"), { environment });
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true, environment: environment ?? getRuntimeConfigEnvironment() });
});

// ── Config Lifecycle ──

app.get("/api/config", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  const environment = resolveConfigEnvironment(c);
  return c.json({
    currentEnvironment: getRuntimeConfigEnvironment(),
    currentStage: getRuntimeConfigStage(),
    environments: listConfigEnvironments(),
    status: getConfigStatus(environment),
  });
});

app.get("/api/config/releases", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  const environment = resolveConfigEnvironment(c);
  return c.json({
    environment: environment ?? getRuntimeConfigEnvironment(),
    releases: listConfigReleases(environment),
  });
});

app.post("/api/config/publish", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  const body = await c.req.json().catch(() => ({}));
  const environment = resolveConfigEnvironment(c, body);
  const release = publishDraft({
    environment,
    note: typeof body.note === "string" ? body.note : undefined,
  });
  return c.json({ environment: environment ?? getRuntimeConfigEnvironment(), release }, 201);
});

app.post("/api/config/rollback", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  const body = await c.req.json().catch(() => ({}));
  const environment = resolveConfigEnvironment(c, body);
  const version = typeof body.version === "number" ? body.version : undefined;
  const releaseId = typeof body.releaseId === "string" ? body.releaseId : undefined;
  const release = rollbackConfig({
    environment,
    version,
    releaseId,
    note: typeof body.note === "string" ? body.note : undefined,
  });

  if (!release) return c.json({ error: "Release not found" }, 404);
  return c.json({ environment: environment ?? getRuntimeConfigEnvironment(), release }, 201);
});

app.post("/api/config/promote", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  if (typeof body.sourceEnvironment !== "string" || typeof body.targetEnvironment !== "string") {
    return c.json({ error: "sourceEnvironment and targetEnvironment are required" }, 400);
  }

  const result = promoteConfig({
    sourceEnvironment: body.sourceEnvironment,
    targetEnvironment: body.targetEnvironment,
    releaseId: typeof body.releaseId === "string" ? body.releaseId : undefined,
    version: typeof body.version === "number" ? body.version : undefined,
    publish: body.publish === true,
    note: typeof body.note === "string" ? body.note : undefined,
  });

  if (!result) return c.json({ error: "Source release not found" }, 404);
  return c.json(result, result.release ? 201 : 200);
});

// ── Knowledge ──

app.post("/api/knowledge", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const environment = resolveConfigEnvironment(c, body);
  const agent = body.agent ?? listAgents({ environment, stage: "draft" })[0] ?? "default";
  const result = addKnowledge({ ...body, agent }, { environment });
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json({ environment: environment ?? getRuntimeConfigEnvironment(), item: result.item }, 201);
});

app.get("/api/knowledge", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  const agent = c.req.query("agent");
  const environment = resolveConfigEnvironment(c);
  const stage = resolveConfigStage(c);
  return c.json({
    environment: environment ?? getRuntimeConfigEnvironment(),
    stage: stage ?? getRuntimeConfigStage(),
    items: listKnowledge(agent ?? undefined, { environment, stage }),
  });
});

app.get("/api/knowledge/:id", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  const environment = resolveConfigEnvironment(c);
  const stage = resolveConfigStage(c);
  const item = getKnowledge(c.req.param("id"), { environment, stage });
  if (!item) return c.json({ error: "Not found" }, 404);
  return c.json({ environment: environment ?? getRuntimeConfigEnvironment(), stage: stage ?? getRuntimeConfigStage(), item });
});

app.put("/api/knowledge/:id", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const environment = resolveConfigEnvironment(c, body);
  const updated = updateKnowledge(c.req.param("id"), body, { environment });
  if (!updated) return c.json({ error: "Not found or would exceed size limit" }, 400);
  return c.json({ environment: environment ?? getRuntimeConfigEnvironment(), item: updated });
});

app.delete("/api/knowledge/:id", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  const environment = resolveConfigEnvironment(c);
  deleteKnowledge(c.req.param("id"), { environment });
  return c.json({ ok: true, environment: environment ?? getRuntimeConfigEnvironment() });
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
  const environment = resolveConfigEnvironment(c, body);
  const agent = body.agent ?? listAgents({ environment, stage: "draft" })[0] ?? "default";
  const result = registerTool(body, agent, { environment });
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json({ environment: environment ?? getRuntimeConfigEnvironment(), tool: result.tool }, 201);
});

app.get("/api/tools", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  const agent = c.req.query("agent");
  const environment = resolveConfigEnvironment(c);
  const stage = resolveConfigStage(c);
  return c.json({
    environment: environment ?? getRuntimeConfigEnvironment(),
    stage: stage ?? getRuntimeConfigStage(),
    tools: listTools(agent ?? undefined, { environment, stage }),
  });
});

app.get("/api/tools/:name", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  const environment = resolveConfigEnvironment(c);
  const stage = resolveConfigStage(c);
  const tool = getTool(c.req.param("name"), { environment, stage });
  if (!tool) return c.json({ error: "Not found" }, 404);
  return c.json({ environment: environment ?? getRuntimeConfigEnvironment(), stage: stage ?? getRuntimeConfigStage(), tool });
});

app.put("/api/tools/:name", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const environment = resolveConfigEnvironment(c, body);
  const updated = updateTool(c.req.param("name"), body, { environment });
  if (!updated) return c.json({ error: "Not found" }, 404);
  return c.json({ environment: environment ?? getRuntimeConfigEnvironment(), tool: updated });
});

app.delete("/api/tools/:name", async (c) => {
  const admin = await requireAdminAccess(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);

  const environment = resolveConfigEnvironment(c);
  deleteTool(c.req.param("name"), { environment });
  return c.json({ ok: true, environment: environment ?? getRuntimeConfigEnvironment() });
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
