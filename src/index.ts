// Clawless — OpenClaw agent runtime for serverless
// The same Pi SDK agent brain, without the Gateway daemon.

// Core
export { runAgent } from "./runtime/agent.js";
export type { AgentRunResult } from "./runtime/agent.js";
export { runAgentStream } from "./runtime/stream.js";
export type { SSEEvent } from "./runtime/stream.js";
export type { ClawlessRequest, ClawlessResponse, AgentRunConfig } from "./runtime/types.js";
export { initializeClawless } from "./bootstrap.js";

// Agent config
export { defineAgent, registerAgent, getAgent, getDefaultAgent, listAgents } from "./config/agent-def.js";
export type { AgentDef, AgentBuiltinPolicy, AgentGuardrails } from "./config/agent-def.js";
export { loadConfig } from "./config/loader.js";

// Knowledge & secrets
export {
  addKnowledge, updateKnowledge, deleteKnowledge, getKnowledge,
  listKnowledge, buildSystemPrompt,
  setSecret, deleteSecret, listSecretKeys, hasSecret,
} from "./config/knowledge.js";
export type { KnowledgeItem } from "./config/knowledge.js";

// Dynamic tools
export { defineTool, Type } from "./tools/interface.js";
export { httpTool } from "./tools/http-tool.js";
export type { HttpToolConfig } from "./tools/http-tool.js";
export {
  registerTool, updateTool, deleteTool, getTool,
  listTools, buildDynamicTools,
} from "./config/tool-store.js";
export type { StoredToolConfig } from "./config/tool-store.js";

// Built-in tools
export {
  getEnabledBuiltins, listBuiltins, enableBuiltin, disableBuiltin,
} from "./tools/builtins/index.js";

// Session
export { getSessionStore, setSessionStore, MemorySessionStore } from "./session/index.js";
export type { SessionStore, SessionData } from "./session/store.js";

// Memo
export { getMemoStore, setMemoStore, MemoryMemoStore } from "./memo/index.js";
export type { MemoStore, MemoEntry } from "./memo/store.js";

// HTTP
export { app } from "./router/handler.js";
