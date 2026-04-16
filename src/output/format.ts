import { completeSimple, type Api, type Model } from "@mariozechner/pi-ai";
import type { AgentOutputSchema } from "../config/agent-def.js";
import {
  createMarkdownFallbackOutput,
  describeAllowedBlocks,
  describePreferredBlocks,
  describeRequiredBlocks,
  getOutputSchemaMode,
  parseStructuredOutputText,
  type StructuredOutput,
} from "./schema.js";

export interface StructuredOutputFormatInput {
  prompt: string;
  result: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown>; result: string; ui?: StructuredOutput | null; isError: boolean }>;
}

function truncate(value: string, max = 1500): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function buildFormatterPrompt(
  input: StructuredOutputFormatInput,
  schema: AgentOutputSchema
): string {
  const toolSummaries = input.toolCalls.length > 0
    ? input.toolCalls.map((call) => ({
        name: call.name,
        args: call.args,
        result: truncate(call.result),
        isError: call.isError,
      }))
    : [];

  const preferred = describePreferredBlocks(schema);

  return [
    "Convert the following agent result into structured UI JSON.",
    `Allowed block types: ${describeAllowedBlocks(schema)}.`,
    preferred ? `Preferred block types: ${preferred}.` : "",
    describeRequiredBlocks(schema) ? `Required block types: ${describeRequiredBlocks(schema)}.` : "",
    schema.requireCitations ? "Citations are required when facts come from external sources or tool results." : "",
    schema.instructions ? `Additional presentation rules: ${schema.instructions}` : "",
    "",
    "Return JSON only. No markdown fence. No prose outside the JSON.",
    "Schema:",
    '{"version":1,"summary":"optional","blocks":[...]}',
    "",
    "User prompt:",
    input.prompt,
    "",
    "Assistant result:",
    input.result,
    "",
    "Tool calls:",
    JSON.stringify(toolSummaries, null, 2),
  ].filter(Boolean).join("\n");
}

function extractAssistantText(message: Awaited<ReturnType<typeof completeSimple>>): string {
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export async function maybeFormatStructuredOutput(
  model: Model<Api>,
  input: StructuredOutputFormatInput,
  schema?: AgentOutputSchema,
  signal?: AbortSignal
): Promise<StructuredOutput | null> {
  if (!schema || getOutputSchemaMode(schema) !== "required") {
    return null;
  }

  try {
    const message = await completeSimple(model, {
      systemPrompt:
        "You are a strict UI response formatter. " +
        "Return a single valid JSON object and nothing else. " +
        "Do not invent facts that are not present in the input.",
      messages: [
        {
          role: "user",
          content: buildFormatterPrompt(input, schema),
          timestamp: Date.now(),
        },
      ],
    }, { signal });

    return parseStructuredOutputText(extractAssistantText(message), schema);
  } catch {
    return createMarkdownFallbackOutput(input.result, schema);
  }
}

export interface StructuredOutputRepairInput extends StructuredOutputFormatInput {
  currentOutput?: StructuredOutput | null;
  validationErrors: string[];
}

function buildRepairPrompt(
  input: StructuredOutputRepairInput,
  schema: AgentOutputSchema
): string {
  const currentOutput = input.currentOutput
    ? JSON.stringify(input.currentOutput, null, 2)
    : "null";

  return [
    "Repair the following structured UI JSON so it satisfies the declared schema contract.",
    `Allowed block types: ${describeAllowedBlocks(schema)}.`,
    describePreferredBlocks(schema) ? `Preferred block types: ${describePreferredBlocks(schema)}.` : "",
    describeRequiredBlocks(schema) ? `Required block types: ${describeRequiredBlocks(schema)}.` : "",
    schema.requireCitations ? "Citations are required when facts come from external sources or tool results." : "",
    schema.instructions ? `Additional presentation rules: ${schema.instructions}` : "",
    "",
    "Validation errors that must be fixed:",
    JSON.stringify(input.validationErrors, null, 2),
    "",
    "Return JSON only. No markdown fence. No prose outside the JSON.",
    "Schema:",
    '{"version":1,"summary":"optional","blocks":[...]}',
    "",
    "Current structured output:",
    currentOutput,
    "",
    "User prompt:",
    input.prompt,
    "",
    "Assistant result:",
    input.result,
    "",
    "Tool calls:",
    JSON.stringify(input.toolCalls.map((call) => ({
      name: call.name,
      args: call.args,
      result: truncate(call.result),
      ui: call.ui ?? null,
      isError: call.isError,
    })), null, 2),
  ].filter(Boolean).join("\n");
}

export async function repairStructuredOutput(
  model: Model<Api>,
  input: StructuredOutputRepairInput,
  schema?: AgentOutputSchema,
  signal?: AbortSignal
): Promise<StructuredOutput | null> {
  if (!schema) {
    return null;
  }

  try {
    const message = await completeSimple(model, {
      systemPrompt:
        "You are a strict UI response repairer. " +
        "Return a single valid JSON object and nothing else. " +
        "You must satisfy the requested block contract exactly.",
      messages: [
        {
          role: "user",
          content: buildRepairPrompt(input, schema),
          timestamp: Date.now(),
        },
      ],
    }, { signal });

    return parseStructuredOutputText(extractAssistantText(message), schema);
  } catch {
    return null;
  }
}
