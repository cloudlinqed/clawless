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
export {
  defineAgent,
  registerAgent,
  getAgent,
  getAgentFor,
  getDefaultAgent,
  getDefaultAgentFor,
  listAgents,
  listRuntimeAgentConfigs,
  listRuntimeAgentConfigsFor,
  getRuntimeAgentConfig,
  upsertRuntimeAgentConfig,
  deleteRuntimeAgentConfigFor,
} from "./config/agent-def.js";
export type {
  AgentDef,
  AgentBuiltinPolicy,
  AgentGuardrails,
  AgentNetworkPolicy,
  AgentOutputBlockType,
  AgentOutputSchema,
  AgentRetrievalConfig,
  AgentRetrievalSource,
  AgentRetrievalSourceKnowledge,
  AgentRetrievalSourceRetriever,
} from "./config/agent-def.js";
export {
  RuntimeAgentConfigSchema,
  mergeAgentConfig,
} from "./config/runtime-agent-config.js";
export type { RuntimeAgentConfig } from "./config/runtime-agent-config.js";
export { loadConfig } from "./config/loader.js";

// Config lifecycle
export {
  getRuntimeConfigEnvironment,
  getRuntimeConfigStage,
  getConfigSnapshot,
  getConfigStatus,
  listConfigEnvironments,
  listConfigReleases,
  getConfigRelease,
  publishDraft,
  rollbackConfig,
  promoteConfig,
} from "./config/lifecycle.js";
export type {
  ConfigStage,
  ConfigSnapshot,
  ConfigDraft,
  ConfigRelease,
} from "./config/lifecycle.js";

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

// Structured output
export type {
  StructuredOutput,
  StructuredOutputBlock,
  OutputAction,
  OutputCitation,
} from "./output/schema.js";
export { adaptToolResultToOutput } from "./output/tool-result-adapter.js";
export type { ToolResultAdapterInput } from "./output/tool-result-adapter.js";
export {
  finalizeStructuredOutput,
  validateOutputContract,
  StructuredOutputContractError,
} from "./output/postprocess.js";
export type { StructuredOutputPostprocessInput, StructuredOutputPostprocessResult } from "./output/postprocess.js";

// Retrieval
export {
  retrieveAgentContext,
  getRetrievalMode,
  shouldInjectStaticKnowledge,
} from "./retrieval/index.js";
export {
  registerRetriever,
  getRetriever,
  listRetrievers,
} from "./retrieval/registry.js";
export type {
  Retriever,
  RetrieverRequest,
  RetrievedDocument,
} from "./retrieval/registry.js";
