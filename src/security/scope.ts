import type { Model, Api } from "@mariozechner/pi-ai";
import type { AgentDef } from "../config/agent-def.js";
import { runAgent } from "../runtime/agent.js";

function getScopeDescription(agentDef: AgentDef): string {
  return agentDef.guardrails?.domain?.trim() || agentDef.instructions.trim();
}

export function getOutOfScopeMessage(agentDef: Pick<AgentDef, "guardrails">): string {
  const guardrails = agentDef.guardrails ?? {};
  return (
    guardrails.outOfScopeMessage ??
    (guardrails.domain
      ? `I can only help with ${guardrails.domain}.`
      : "I can only help with tasks that fall within my configured scope.")
  );
}

export function shouldEnforceScope(agentDef: Pick<AgentDef, "guardrails">): boolean {
  return agentDef.guardrails?.refuseOutOfScope ?? true;
}

function parseClassifierDecision(text: string): "in" | "out" | null {
  const normalized = text.trim().toUpperCase();
  if (normalized === "IN" || normalized.startsWith("IN\n")) return "in";
  if (normalized === "OUT" || normalized.startsWith("OUT\n")) return "out";

  const firstWord = normalized.match(/\b(IN|OUT)\b/);
  if (!firstWord) return null;
  return firstWord[1] === "IN" ? "in" : "out";
}

export async function evaluatePromptScope(
  prompt: string,
  agentDef: AgentDef,
  model: Model<Api>,
  signal?: AbortSignal
): Promise<{ allowed: boolean }> {
  if (!shouldEnforceScope(agentDef)) {
    return { allowed: true };
  }

  const classifierPrompt = [
    "Agent scope:",
    getScopeDescription(agentDef),
    "",
    "User request:",
    prompt,
    "",
    "Rules:",
    "- Return IN only if the request is clearly within the agent's intended role and domain.",
    "- Return OUT for unrelated requests, generic off-domain questions, or requests for internal backend details.",
    "- Return exactly one token: IN or OUT.",
  ].join("\n");

  const result = await runAgent(classifierPrompt, {
    model,
    systemPrompt:
      "You are a strict scope classifier for an application agent. " +
      "You do not answer the user's request. You only classify scope. " +
      "Return exactly one token: IN or OUT.",
    tools: [],
    maxTurns: 1,
    signal,
  });

  const decision = parseClassifierDecision(result.result);
  if (decision === "in") return { allowed: true };
  if (decision === "out") return { allowed: false };
  throw new Error(`Failed to parse scope classifier result: ${result.result}`);
}
