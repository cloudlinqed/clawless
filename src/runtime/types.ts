import type { AgentTool, AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import type { Model, Api, Usage } from "@mariozechner/pi-ai";
import type { AgentOutputSchema } from "../config/agent-def.js";
import type { StructuredOutput } from "../output/schema.js";
import type { RetrievedDocument } from "../retrieval/registry.js";

export interface ClawlessRequest {
  prompt: string;
  agent: string;
  sessionKey?: string;
  model?: string;
  provider?: string;
  maxTurns?: number;
  systemPrompt?: string;
}

export interface ClawlessResponse {
  sessionKey: string;
  result: string;
  output?: StructuredOutput | null;
  retrieval?: RetrievedDocument[];
  toolCalls: ToolCallRecord[];
  usage: UsageSummary;
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result: string;
  ui?: StructuredOutput | null;
  isError: boolean;
}

export interface UsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  turns: number;
}

export interface AgentRunConfig {
  model: Model<Api>;
  systemPrompt: string;
  tools: AgentTool[];
  outputSchema?: AgentOutputSchema;
  messages?: AgentMessage[];
  maxTurns?: number;
  signal?: AbortSignal;
  getApiKey?: (provider: string) => string | undefined;
  onEvent?: (event: AgentEvent) => void;
}
