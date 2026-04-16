import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import { streamSimple, getEnvApiKey } from "@mariozechner/pi-ai";
import type { Message, AssistantMessage } from "@mariozechner/pi-ai";
import type { AgentRunConfig, ToolCallRecord, UsageSummary } from "./types.js";
import { adaptToolResultToOutput } from "../output/tool-result-adapter.js";
import { finalizeStructuredOutput } from "../output/postprocess.js";
import { parseStructuredOutputResult } from "../output/tool.js";
import type { StructuredOutput } from "../output/schema.js";

export interface AgentRunResult {
  messages: AgentMessage[];
  result: string;
  output: StructuredOutput | null;
  toolCalls: ToolCallRecord[];
  usage: UsageSummary;
}

/**
 * Run the Pi SDK agent loop with a text prompt.
 *
 * This is the core of clawless — the same agent brain OpenClaw uses,
 * without the Gateway daemon. Creates an Agent, sets tools/model/prompt,
 * runs the multi-step loop, and returns the result.
 *
 * For multi-turn: pass previous messages via config.messages.
 * The agent restores context and continues the conversation.
 */
export async function runAgent(
  prompt: string,
  config: AgentRunConfig
): Promise<AgentRunResult> {
  const toolCalls: ToolCallRecord[] = [];
  let structuredOutput: StructuredOutput | null = null;
  let turnCount = 0;
  const maxTurns = config.maxTurns ?? 10;
  const toolByName = new Map(config.tools.map((tool) => [tool.name, tool]));

  const agent = new Agent({
    streamFn: streamSimple,
    getApiKey: config.getApiKey ?? ((provider) => getEnvApiKey(provider)),
    toolExecution: "parallel",
    afterToolCall: async (ctx) => {
      const resultText = ctx.result.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
      const tool = toolByName.get(ctx.toolCall.name);
      const ui = adaptToolResultToOutput({
        toolName: ctx.toolCall.name,
        toolLabel: tool?.label,
        args: ctx.args as Record<string, unknown>,
        resultText,
        isError: ctx.isError,
      });

      toolCalls.push({
        name: ctx.toolCall.name,
        args: ctx.args as Record<string, unknown>,
        result: resultText,
        ui,
        isError: ctx.isError,
      });

      if (!ctx.isError && ctx.toolCall.name === "present_output") {
        structuredOutput = parseStructuredOutputResult(resultText, config.outputSchema);
      }
      return undefined;
    },
  });

  // Configure agent state
  agent.state.model = config.model;
  agent.state.systemPrompt = config.systemPrompt;
  agent.state.tools = config.tools;

  // Restore previous conversation for multi-turn
  if (config.messages && config.messages.length > 0) {
    agent.state.messages = [...config.messages];
  }

  // Track turns and enforce limit
  const unsubscribe = agent.subscribe((event: AgentEvent) => {
    config.onEvent?.(event);
    if (event.type === "turn_end") {
      turnCount++;
      if (turnCount >= maxTurns) {
        agent.abort();
      }
    }
  });

  try {
    // Wire abort signal
    if (config.signal) {
      config.signal.addEventListener("abort", () => agent.abort(), { once: true });
    }

    await agent.prompt(prompt);
    await agent.waitForIdle();
  } finally {
    unsubscribe();
  }

  const allMessages = agent.state.messages;
  const result = extractFinalText(allMessages);
  const usage = accumulateUsage(allMessages);
  const finalized = await finalizeStructuredOutput(config.model, {
    prompt,
    result,
    currentOutput: structuredOutput,
    toolCalls,
  }, config.outputSchema, config.signal);
  const output = finalized.output;

  return {
    messages: allMessages,
    result,
    output,
    toolCalls,
    usage: { ...usage, turns: turnCount },
  };
}

function extractFinalText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Message;
    if (msg.role === "assistant") {
      const assistant = msg as AssistantMessage;
      return assistant.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
    }
  }
  return "";
}

function accumulateUsage(messages: AgentMessage[]): Omit<UsageSummary, "turns"> {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (const msg of messages) {
    const m = msg as Message;
    if (m.role === "assistant") {
      const assistant = m as AssistantMessage;
      if (assistant.usage) {
        totalInputTokens += assistant.usage.input;
        totalOutputTokens += assistant.usage.output;
      }
    }
  }

  return {
    totalInputTokens,
    totalOutputTokens,
    totalTokens: totalInputTokens + totalOutputTokens,
  };
}
