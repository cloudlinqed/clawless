import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import { streamSimple, getEnvApiKey } from "@mariozechner/pi-ai";
import type { Message, AssistantMessage, AssistantMessageEvent } from "@mariozechner/pi-ai";
import type { AgentRunConfig, ToolCallRecord } from "./types.js";
import { adaptToolResultToOutput } from "../output/tool-result-adapter.js";
import { finalizeStructuredOutput } from "../output/postprocess.js";
import { parseStructuredOutputResult } from "../output/tool.js";
import type { StructuredOutput } from "../output/schema.js";
import type { RetrievedDocument } from "../retrieval/registry.js";

/**
 * SSE event types emitted during agent execution.
 * These carry enough data for both basic text streaming and A2UI rendering.
 */
export type SSEEvent =
  | { event: "agent_start" }
  | { event: "retrieval_ready"; data: { documents: RetrievedDocument[] } }
  | { event: "turn_start"; data: { turn: number } }
  | { event: "text_delta"; data: { delta: string } }
  | { event: "text_done"; data: { text: string } }
  | { event: "output_ready"; data: { output: StructuredOutput } }
  | { event: "tool_start"; data: { toolCallId: string; toolName: string; args: unknown } }
  | { event: "tool_update"; data: { toolCallId: string; toolName: string; partialResult: unknown } }
  | { event: "tool_end"; data: { toolCallId: string; toolName: string; result: unknown; ui: StructuredOutput | null; isError: boolean } }
  | { event: "turn_end"; data: { turn: number } }
  | { event: "agent_end"; data: { sessionKey: string; result: string; output: StructuredOutput | null; retrieval?: RetrievedDocument[]; toolCalls: ToolCallRecord[]; usage: { totalInputTokens: number; totalOutputTokens: number; totalTokens: number; turns: number } } }
  | { event: "error"; data: { message: string } };

/**
 * Run the agent and yield SSE events as they happen.
 *
 * The caller converts these to SSE format and streams to the client.
 * Events are granular enough for A2UI: the frontend receives text deltas,
 * tool execution lifecycle, and turn boundaries in real time.
 */
export async function* runAgentStream(
  prompt: string,
  config: AgentRunConfig & { sessionId: string }
): AsyncGenerator<SSEEvent> {
  const toolCalls: ToolCallRecord[] = [];
  let turnCount = 0;
  const maxTurns = config.maxTurns ?? 10;
  let lastAssistantText = "";
  let structuredOutput: StructuredOutput | null = null;
  const toolByName = new Map(config.tools.map((tool) => [tool.name, tool]));
  const toolUiById = new Map<string, StructuredOutput | null>();

  // Event queue — agent events are pushed here, yielded by the generator
  const eventQueue: SSEEvent[] = [];
  let resolveWait: (() => void) | undefined;
  let agentDone = false;

  function push(event: SSEEvent) {
    eventQueue.push(event);
    const r = resolveWait;
    if (r) {
      resolveWait = undefined;
      r();
    }
  }

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
      toolUiById.set(ctx.toolCall.id, ui);

      toolCalls.push({
        name: ctx.toolCall.name,
        args: ctx.args as Record<string, unknown>,
        result: resultText,
        ui,
        isError: ctx.isError,
      });

      if (!ctx.isError && ctx.toolCall.name === "present_output") {
        const parsed = parseStructuredOutputResult(resultText, config.outputSchema);
        if (parsed) {
          structuredOutput = parsed;
          push({ event: "output_ready", data: { output: parsed } });
        }
      }
      return undefined;
    },
  });

  agent.state.model = config.model;
  agent.state.systemPrompt = config.systemPrompt;
  agent.state.tools = config.tools;

  if (config.messages && config.messages.length > 0) {
    agent.state.messages = [...config.messages];
  }

  const unsubscribe = agent.subscribe((event: AgentEvent) => {
    config.onEvent?.(event);

    switch (event.type) {
      case "agent_start":
        push({ event: "agent_start" });
        break;

      case "turn_start":
        turnCount++;
        push({ event: "turn_start", data: { turn: turnCount } });
        break;

      case "message_update": {
        const ame = event.assistantMessageEvent as AssistantMessageEvent;
        if (ame.type === "text_delta") {
          push({ event: "text_delta", data: { delta: ame.delta } });
        }
        break;
      }

      case "message_end": {
        const msg = event.message as Message;
        if (msg.role === "assistant") {
          const assistant = msg as AssistantMessage;
          lastAssistantText = assistant.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("");
          push({ event: "text_done", data: { text: lastAssistantText } });
        }
        break;
      }

      case "tool_execution_start":
        push({
          event: "tool_start",
          data: { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args },
        });
        break;

      case "tool_execution_update":
        push({
          event: "tool_update",
          data: { toolCallId: event.toolCallId, toolName: event.toolName, partialResult: event.partialResult },
        });
        break;

      case "tool_execution_end":
        push({
          event: "tool_end",
          data: {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            result: event.result,
            ui: toolUiById.get(event.toolCallId) ?? null,
            isError: event.isError,
          },
        });
        break;

      case "turn_end":
        push({ event: "turn_end", data: { turn: turnCount } });
        if (turnCount >= maxTurns) {
          agent.abort();
        }
        break;

      case "agent_end":
        // Final event pushed after idle below
        break;
    }
  });

  // Start the agent in the background
  const runPromise = (async () => {
    try {
      if (config.signal) {
        config.signal.addEventListener("abort", () => agent.abort(), { once: true });
      }
      await agent.prompt(prompt);
      await agent.waitForIdle();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      push({ event: "error", data: { message } });
    } finally {
      unsubscribe();

      // Emit final summary
      const allMessages = agent.state.messages;
      const usage = accumulateUsage(allMessages);
      const previousOutputSignature = structuredOutput ? JSON.stringify(structuredOutput) : null;
      try {
        const finalized = await finalizeStructuredOutput(config.model, {
          prompt,
          result: lastAssistantText,
          currentOutput: structuredOutput,
          toolCalls,
        }, config.outputSchema, config.signal);
        structuredOutput = finalized.output;

        if (structuredOutput && JSON.stringify(structuredOutput) !== previousOutputSignature) {
          push({ event: "output_ready", data: { output: structuredOutput } });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        push({ event: "error", data: { message } });
      }

      push({
        event: "agent_end",
        data: {
          sessionKey: config.sessionId,
          result: lastAssistantText,
          output: structuredOutput,
          toolCalls,
          usage: { ...usage, turns: turnCount },
        },
      });

      agentDone = true;
      const r = resolveWait;
      if (r) {
        resolveWait = undefined;
        r();
      }
    }
  })();

  // Yield events as they arrive
  while (true) {
    while (eventQueue.length > 0) {
      yield eventQueue.shift()!;
    }

    if (agentDone && eventQueue.length === 0) break;

    // Wait for next event
    await new Promise<void>((resolve) => {
      resolveWait = resolve;
    });
  }

  return agent.state.messages;
}

function accumulateUsage(messages: AgentMessage[]) {
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

  return { totalInputTokens, totalOutputTokens, totalTokens: totalInputTokens + totalOutputTokens };
}
