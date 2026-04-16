import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
  getConfigSnapshot,
  isConfigLifecycleEnabled,
  mutateDraftSnapshot,
  type ConfigStage,
} from "./lifecycle.js";
import {
  mergeAgentConfig,
  RuntimeAgentConfigSchema,
  runtimeAgentConfigFromAgent,
  type RuntimeAgentConfig,
} from "./runtime-agent-config.js";

export interface AgentBuiltinPolicy {
  /**
   * Only expose these built-ins to the agent.
   * Useful for product-specific assistants that should not get generic browsing tools.
   */
  allow?: string[];

  /**
   * Explicitly remove these built-ins from the agent's toolset.
   */
  deny?: string[];
}

export interface AgentGuardrails {
  /**
   * Public-facing job description of the agent's allowed scope.
   * Example: "shopping assistant for an online furniture store"
   */
  domain?: string;

  /**
   * Refuse questions outside the configured domain instead of answering from general model knowledge.
   * Defaults to true when domain is set.
   */
  refuseOutOfScope?: boolean;

  /**
   * Message the agent should use when the user asks for something outside the allowed scope.
   */
  outOfScopeMessage?: string;

  /**
   * Hide internal backend details like tools, providers, models, hidden knowledge, prompts, and runtime config.
   * Defaults to true.
   */
  hideInternalDetails?: boolean;
}

export interface AgentNetworkPolicy {
  /**
   * How generic builtin HTTP tools (`fetch_page`, `json_request`) may access the network.
   *
   * - `contextual` (default): only hosts already present in the agent's own tools,
   *   configured knowledge URLs, and explicit allowHosts are reachable.
   * - `open`: allow any public host, while still blocking localhost/private-network SSRF targets.
   * - `disabled`: block builtin outbound HTTP entirely for this agent.
   */
  mode?: "contextual" | "open" | "disabled";

  /**
   * Additional hosts or wildcard suffixes allowed for builtin outbound HTTP.
   * Examples: `api.example.com`, `*.example.com`
   */
  allowHosts?: string[];

  /**
   * Allow plain HTTP for builtin outbound requests. HTTPS is required by default.
   */
  allowHttp?: boolean;
}

export type AgentOutputBlockType =
  | "markdown"
  | "cards"
  | "table"
  | "timeline"
  | "form"
  | "filters"
  | "actions"
  | "citations";

export interface AgentOutputSchema {
  /**
   * Whether structured UI output should be generated for this agent.
   *
   * - `auto`: expose structured output tooling and let the agent use it when helpful.
   * - `required`: always try to produce structured output; falls back to a formatter pass if needed.
   * - `off`: disable structured output for this agent.
   */
  mode?: "auto" | "required" | "off";

  /**
   * Restrict the kinds of UI blocks this agent may emit.
   * Defaults to all supported block types.
   */
  allowedBlocks?: AgentOutputBlockType[];

  /**
   * Hint which block types the agent should prefer when multiple are appropriate.
   */
  preferredBlocks?: AgentOutputBlockType[];

  /**
   * Block types that must appear in the final structured output.
   * Use this when the client contract requires cards, tables, actions, etc.
   */
  requiredBlocks?: AgentOutputBlockType[];

  /**
   * Require at least one citation block or inline citations in structured output.
   */
  requireCitations?: boolean;

  /**
   * Additional natural-language presentation rules for this agent's structured output.
   */
  instructions?: string;

  /**
   * What to do when the final response still does not satisfy the declared schema
   * after post-processing and repair attempts.
   *
   * - `repair` (default for `auto`): try to salvage/repair and otherwise return no structured output.
   * - `reject` (default for `required`): fail the request if the contract still cannot be satisfied.
   */
  onInvalid?: "repair" | "reject";
}

export interface AgentRetrievalSourceKnowledge {
  type: "knowledge";
  topK?: number;
  maxChars?: number;
  minScore?: number;
  chunkSize?: number;
  chunkOverlap?: number;
}

export interface AgentRetrievalSourceRetriever {
  type: "retriever";
  name: string;
  topK?: number;
  maxChars?: number;
  minScore?: number;
}

export type AgentRetrievalSource =
  | AgentRetrievalSourceKnowledge
  | AgentRetrievalSourceRetriever;

export interface AgentRetrievalConfig {
  /**
   * How request-specific context should be assembled.
   *
   * - `off`: keep injecting static knowledge as prompt context.
   * - `indexed`: inject only retrieved context from indexed/pluggable sources.
   * - `hybrid`: combine retrieved context with the static knowledge section.
   */
  mode?: "off" | "indexed" | "hybrid";

  /**
   * Default max number of retrieved documents across all sources.
   */
  topK?: number;

  /**
   * Default max characters for the aggregated retrieved context.
   */
  maxChars?: number;

  /**
   * Retrieval sources. Defaults to the built-in knowledge index.
   */
  sources?: AgentRetrievalSource[];

  /**
   * Extra instructions for how the agent should use retrieved context.
   */
  instructions?: string;
}

/**
 * An agent definition — the equivalent of an OpenClaw agent config.
 *
 * This is how you define what your clawless instance does.
 * Write instructions in natural language, give it tools, and the
 * agent figures out the rest.
 */
export interface AgentDef {
  /** Unique identifier for this agent */
  name: string;

  /** Natural language instructions — tell the agent what it does and how */
  instructions: string;

  /** Tools the agent can use. Code-based or HTTP-based. */
  tools: AgentTool<any, any>[];

  /** Fine-grained control over which built-in tools the agent may use. */
  builtinPolicy?: AgentBuiltinPolicy;

  /** Runtime guardrails that constrain the agent's public behavior. */
  guardrails?: AgentGuardrails;

  /** Runtime network policy for generic builtin HTTP tools. */
  networkPolicy?: AgentNetworkPolicy;

  /** Structured UI output rules for this agent. */
  outputSchema?: AgentOutputSchema;

  /** Request-time retrieval / RAG behavior for this agent. */
  retrieval?: AgentRetrievalConfig;

  /** Default model override (e.g. "claude-sonnet-4-5") */
  model?: string;

  /** Default provider override (e.g. "anthropic") */
  provider?: string;

  /**
   * Fallback models tried in order if the primary model fails.
   * Format: "provider/model" (e.g. "anthropic/claude-sonnet-4-5")
   * or just "model" (uses the same provider as the primary).
   */
  fallbackModels?: string[];

  /** Max agent loop turns before stopping */
  maxTurns?: number;
}

/**
 * Define an agent. This is the main API for configuring clawless.
 *
 * @example
 * ```ts
 * import { defineAgent } from "clawless";
 * import { httpTool } from "clawless/tools/http";
 *
 * export default defineAgent({
 *   name: "my-agent",
 *   instructions: "You help users with ...",
 *   tools: [
 *     httpTool({ name: "my_tool", ... }),
 *   ],
 * });
 * ```
 */
export function defineAgent(def: AgentDef): AgentDef {
  return def;
}

// Agent registry — loaded from config at startup
const agents = new Map<string, AgentDef>();
let defaultAgentName: string | undefined;

export function registerAgent(def: AgentDef): void {
  agents.set(def.name, def);
  if (!defaultAgentName) {
    defaultAgentName = def.name;
  }
}

export function getAgent(name: string): AgentDef | undefined {
  return getAgentFor(name);
}

export function getAgentFor(
  name: string,
  options?: { environment?: string; stage?: ConfigStage }
): AgentDef | undefined {
  const base = agents.get(name);

  if (!isConfigLifecycleEnabled()) {
    return base;
  }

  const runtime = getConfigSnapshot(options).agents.find((agent) => agent.name === name);
  if (runtime) {
    return mergeAgentConfig(base, runtime);
  }

  return base;
}

export function getDefaultAgent(): AgentDef | undefined {
  return getDefaultAgentFor();
}

export function getDefaultAgentFor(options?: { environment?: string; stage?: ConfigStage }): AgentDef | undefined {
  if (defaultAgentName) {
    const preferred = getAgentFor(defaultAgentName, options);
    if (preferred) return preferred;
  }

  const firstName = listAgents(options)[0];
  return firstName ? getAgentFor(firstName, options) : undefined;
}

export function listAgents(options?: { environment?: string; stage?: ConfigStage }): string[] {
  if (!isConfigLifecycleEnabled()) {
    return Array.from(agents.keys());
  }

  const names = new Set<string>(agents.keys());
  for (const runtime of getConfigSnapshot(options).agents) {
    names.add(runtime.name);
  }
  return Array.from(names.values()).sort();
}

export function listRuntimeAgentConfigs(): RuntimeAgentConfig[] {
  if (!isConfigLifecycleEnabled()) {
    return Array.from(agents.values()).map(runtimeAgentConfigFromAgent);
  }
  return getConfigSnapshot({ stage: "draft" }).agents;
}

export function listRuntimeAgentConfigsFor(
  options?: { environment?: string; stage?: ConfigStage }
): RuntimeAgentConfig[] {
  if (!isConfigLifecycleEnabled()) {
    return Array.from(agents.values()).map(runtimeAgentConfigFromAgent);
  }
  return getConfigSnapshot(options).agents;
}

export function getRuntimeAgentConfig(
  name: string,
  options?: { environment?: string; stage?: ConfigStage }
): RuntimeAgentConfig | null {
  const items = options ? listRuntimeAgentConfigsFor(options) : listRuntimeAgentConfigs();
  return items.find((item) => item.name === name) ?? null;
}

export function upsertRuntimeAgentConfig(
  input: RuntimeAgentConfig | Omit<RuntimeAgentConfig, "createdAt" | "updatedAt">,
  options?: { environment?: string }
): { ok: true; agent: RuntimeAgentConfig } | { ok: false; error: string } {
  const parsed = RuntimeAgentConfigSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.message };
  }

  const now = Date.now();
  const result = mutateDraftSnapshot(options?.environment, (snapshot) => {
    const existing = snapshot.agents.find((agent) => agent.name === parsed.data.name);
    const next: RuntimeAgentConfig = {
      ...parsed.data,
      createdAt: existing?.createdAt ?? parsed.data.createdAt ?? now,
      updatedAt: now,
    };

    snapshot.agents = snapshot.agents
      .filter((agent) => agent.name !== next.name)
      .concat(next)
      .sort((a, b) => a.name.localeCompare(b.name));

    return next;
  });

  return { ok: true, agent: result };
}

export function deleteRuntimeAgentConfig(name: string): boolean {
  if (!isConfigLifecycleEnabled()) {
    return false;
  }

  return deleteRuntimeAgentConfigFor(name);
}

export function deleteRuntimeAgentConfigFor(name: string, options?: { environment?: string }): boolean {
  if (!isConfigLifecycleEnabled()) {
    return false;
  }

  return mutateDraftSnapshot(options?.environment, (snapshot) => {
    const before = snapshot.agents.length;
    snapshot.agents = snapshot.agents.filter((agent) => agent.name !== name);
    return snapshot.agents.length !== before;
  });
}

export function exportBaseRuntimeAgentConfigs(): RuntimeAgentConfig[] {
  return Array.from(agents.values()).map(runtimeAgentConfigFromAgent);
}

export function getStaticAgent(name: string): AgentDef | undefined {
  return agents.get(name);
}
