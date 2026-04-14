import type { AgentTool } from "@mariozechner/pi-agent-core";

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
  return agents.get(name);
}

export function getDefaultAgent(): AgentDef | undefined {
  if (defaultAgentName) return agents.get(defaultAgentName);
  const first = agents.values().next();
  return first.done ? undefined : first.value;
}

export function listAgents(): string[] {
  return Array.from(agents.keys());
}
