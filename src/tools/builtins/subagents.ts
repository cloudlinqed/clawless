import { defineTool, Type } from "../interface.js";
import { getSpawnedAgents, clearSpawnedAgents } from "./sessions-spawn.js";

export const subagentsTool = defineTool({
  name: "subagents",
  label: "Manage Sub-Agents",
  description:
    "List and manage sub-agents spawned with sessions_spawn. " +
    "Use this to check on completed sub-agents, review their results, " +
    "or clear the spawn history.",
  parameters: Type.Object({
    action: Type.String({
      description: "list — show all spawned agents and their status. clear — clear spawn history.",
    }),
  }),
  execute: async (params) => {
    const action = params.action.toLowerCase();

    if (action === "clear") {
      clearSpawnedAgents();
      return JSON.stringify({ ok: true, message: "Spawn history cleared" });
    }

    // Default: list
    const agents = getSpawnedAgents();

    if (agents.length === 0) {
      return JSON.stringify({ agents: [], message: "No sub-agents have been spawned in this session" });
    }

    const summary = agents.map((a) => ({
      id: a.id,
      task: a.task.slice(0, 100) + (a.task.length > 100 ? "..." : ""),
      agent: a.agentName,
      status: a.status,
      result: a.result ? a.result.slice(0, 200) + (a.result.length > 200 ? "..." : "") : undefined,
      toolCalls: a.toolCalls?.length ?? 0,
      error: a.error,
      durationMs: a.completedAt ? a.completedAt - a.startedAt : undefined,
    }));

    return JSON.stringify({ total: agents.length, agents: summary }, null, 2);
  },
});
