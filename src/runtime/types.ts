import type { AgentTool, AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import type { Model, Api, Usage } from "@mariozechner/pi-ai";

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
  toolCalls: ToolCallRecord[];
  usage: UsageSummary;
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result: string;
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
  messages?: AgentMessage[];
  maxTurns?: number;
  signal?: AbortSignal;
  getApiKey?: (provider: string) => string | undefined;
  onEvent?: (event: AgentEvent) => void;
}
