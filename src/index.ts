// Clawless — OpenClaw agent runtime for serverless
// The same Pi SDK agent brain, without the Gateway daemon.

// Core
export { runAgent } from "./runtime/agent.js";
export type { AgentRunResult } from "./runtime/agent.js";
export { runAgentStream } from "./runtime/stream.js";
export type { SSEEvent } from "./runtime/stream.js";
export type { ClawlessRequest, ClawlessResponse, AgentRunConfig } from "./runtime/types.js";

// Agent config — the main API for defining what your agent does
export { defineAgent, registerAgent, getAgent, getDefaultAgent, listAgents } from "./config/agent-def.js";
export type { AgentDef } from "./config/agent-def.js";
export { loadConfig } from "./config/loader.js";

// Knowledge & secrets — teach the agent about APIs, tools, workflows
export {
  addKnowledge, updateKnowledge, deleteKnowledge, getKnowledge,
  listKnowledge, buildSystemPrompt,
  setSecret, deleteSecret, listSecretKeys, hasSecret,
} from "./config/knowledge.js";
export type { KnowledgeItem } from "./config/knowledge.js";

// Tools
export { defineTool, Type } from "./tools/interface.js";
export { httpTool } from "./tools/http-tool.js";

// Session
export { getSessionStore, setSessionStore, MemorySessionStore } from "./session/index.js";
export type { SessionStore, SessionData } from "./session/store.js";

// HTTP
export { app } from "./router/handler.js";
