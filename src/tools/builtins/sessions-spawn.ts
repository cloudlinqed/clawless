import { defineTool, Type } from "../interface.js";
import { runAgent } from "../../runtime/agent.js";
import { getModel, getEnvApiKey } from "@mariozechner/pi-ai";
import { buildSystemPrompt } from "../../config/knowledge.js";
import { buildDynamicTools } from "../../config/tool-store.js";
import { getEnabledBuiltins } from "./index.js";
import { getAgent, getDefaultAgent } from "../../config/agent-def.js";
import { deriveRequestContext, getRequestSlot, requireRequestContext, runWithRequestContext } from "../../runtime/request-context.js";

/**
 * Sub-agent tracker. Stores results of spawned agents within a request
 * so the parent agent and the subagents tool can inspect them.
 */
export interface SpawnedAgent {
  id: string;
  task: string;
  agentName: string;
  status: "running" | "completed" | "failed";
  result?: string;
  toolCalls?: Array<{ name: string; args: unknown }>;
  error?: string;
  startedAt: number;
  completedAt?: number;
}

const SPAWNED_AGENTS_SLOT = "builtin:spawned_agents";

export function getSpawnedAgents(): SpawnedAgent[] {
  return getRequestSlot<SpawnedAgent[]>(SPAWNED_AGENTS_SLOT, () => []);
}

export function clearSpawnedAgents(): void {
  const spawnedAgents = getSpawnedAgents();
  spawnedAgents.length = 0;
}

export const sessionsSpawnTool = defineTool({
  name: "sessions_spawn",
  label: "Spawn Sub-Agent",
  description:
    "Spawn a sub-agent to handle a focused task. The sub-agent runs with " +
    "the same tools and knowledge but a separate conversation context. " +
    "Use this to parallelize work — e.g. research multiple topics simultaneously, " +
    "compare different approaches, or delegate a complex subtask. " +
    "The sub-agent completes and returns its result to you.",
  parameters: Type.Object({
    task: Type.String({
      description: "Clear instruction for the sub-agent. Be specific about what it should do and return.",
    }),
    agentName: Type.Optional(
      Type.String({ description: "Which agent to use. Defaults to the current agent." })
    ),
  }),
  execute: async (params, signal) => {
    const request = requireRequestContext();
    const agentDef = params.agentName
      ? getAgent(params.agentName)
      : (getAgent(request.agentName) ?? getDefaultAgent());

    if (!agentDef) {
      throw new Error(`Agent not found: ${params.agentName ?? "default"}`);
    }

    const provider = agentDef.provider ?? process.env.DEFAULT_PROVIDER ?? "openai";
    const modelId = agentDef.model ?? process.env.DEFAULT_MODEL;
    if (!modelId) throw new Error("No model configured");

    const model = getModel(provider as any, modelId as any);

    const spawnId = crypto.randomUUID();
    const entry: SpawnedAgent = {
      id: spawnId,
      task: params.task,
      agentName: agentDef.name,
      status: "running",
      startedAt: Date.now(),
    };

    // Track this spawn
    const list = getSpawnedAgents();
    list.push(entry);

    try {
      // Collect all tools for the sub-agent (same as parent)
      const allTools = [
        ...agentDef.tools,
        ...buildDynamicTools(agentDef.name),
        // Give sub-agent builtins but NOT sessions_spawn (prevent infinite recursion)
        ...getEnabledBuiltins()
          .filter((t) => t.name !== "sessions_spawn" && t.name !== "subagents"),
      ];

      const result = await runWithRequestContext(
        deriveRequestContext({ sessionKey: spawnId, agentName: agentDef.name }, { freshSlots: true }),
        () => runAgent(params.task, {
          model,
          systemPrompt: buildSystemPrompt(
            agentDef,
            agentDef.instructions + "\n\nYou are a sub-agent handling a specific task. Be focused and concise."
          ),
          tools: allTools,
          maxTurns: 5,
          signal,
          getApiKey: (p) => getEnvApiKey(p),
        })
      );

      entry.status = "completed";
      entry.result = result.result;
      entry.toolCalls = result.toolCalls.map((tc) => ({ name: tc.name, args: tc.args }));
      entry.completedAt = Date.now();

      return JSON.stringify({
        spawnId,
        status: "completed",
        result: result.result,
        toolCalls: result.toolCalls.length,
        turns: result.usage.turns,
      }, null, 2);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      entry.status = "failed";
      entry.error = message;
      entry.completedAt = Date.now();

      return JSON.stringify({ spawnId, status: "failed", error: message });
    }
  },
});
