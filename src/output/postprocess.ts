import type { Api, Model } from "@mariozechner/pi-ai";
import type { AgentOutputSchema } from "../config/agent-def.js";
import { maybeFormatStructuredOutput, repairStructuredOutput, type StructuredOutputFormatInput } from "./format.js";
import {
  findMissingRequiredBlocks,
  getAllowedOutputBlocks,
  getOutputInvalidPolicy,
  getOutputSchemaMode,
  getPreferredOutputBlocks,
  getRequiredOutputBlocks,
  validateStructuredOutput,
  type StructuredOutput,
  type StructuredOutputBlock,
} from "./schema.js";

export class StructuredOutputContractError extends Error {
  issues: string[];

  constructor(message: string, issues: string[]) {
    super(message);
    this.name = "StructuredOutputContractError";
    this.issues = issues;
  }
}

export interface StructuredOutputPostprocessInput extends StructuredOutputFormatInput {
  currentOutput?: StructuredOutput | null;
}

export interface StructuredOutputPostprocessResult {
  output: StructuredOutput | null;
  source: "direct" | "salvaged" | "formatted" | "repaired" | "none";
  repaired: boolean;
  validationErrors: string[];
}

export async function finalizeStructuredOutput(
  model: Model<Api>,
  input: StructuredOutputPostprocessInput,
  schema?: AgentOutputSchema,
  signal?: AbortSignal
): Promise<StructuredOutputPostprocessResult> {
  if (!schema) {
    return {
      output: input.currentOutput ?? null,
      source: input.currentOutput ? "direct" : "none",
      repaired: false,
      validationErrors: [],
    };
  }

  const mode = getOutputSchemaMode(schema);
  let candidate = input.currentOutput ?? null;
  let errors = candidate
    ? validateOutputContract(candidate, schema)
    : (mode === "required" ? ["Structured output is required for this agent but none was produced."] : []);

  if (candidate && errors.length === 0) {
    return { output: candidate, source: "direct", repaired: false, validationErrors: [] };
  }

  const salvaged = salvageStructuredOutput(candidate, input, schema);
  if (salvaged) {
    const salvageErrors = validateOutputContract(salvaged, schema);
    if (salvageErrors.length === 0) {
      return { output: salvaged, source: "salvaged", repaired: true, validationErrors: [] };
    }
    candidate = salvaged;
    errors = salvageErrors;
  }

  if (!candidate && mode === "required") {
    const formatted = await maybeFormatStructuredOutput(model, input, schema, signal);
    if (formatted) {
      const formattedErrors = validateOutputContract(formatted, schema);
      if (formattedErrors.length === 0) {
        return { output: formatted, source: "formatted", repaired: true, validationErrors: [] };
      }
      candidate = formatted;
      errors = formattedErrors;
    }
  }

  if (errors.length > 0 || (candidate && mode !== "off")) {
    const repaired = await repairStructuredOutput(model, {
      ...input,
      currentOutput: candidate,
      validationErrors: errors.length > 0 ? errors : ["Structured output does not satisfy the declared schema."],
    }, schema, signal);

    if (repaired) {
      const repairErrors = validateOutputContract(repaired, schema);
      if (repairErrors.length === 0) {
        return { output: repaired, source: "repaired", repaired: true, validationErrors: [] };
      }
      candidate = repaired;
      errors = repairErrors;
    }
  }

  const finalErrors = errors.length > 0 ? errors : (
    mode === "required" ? ["Structured output is required for this agent but no valid output was produced."] : []
  );

  if (finalErrors.length > 0 && getOutputInvalidPolicy(schema) === "reject") {
    throw new StructuredOutputContractError(
      "Structured output did not satisfy the declared schema contract.",
      finalErrors
    );
  }

  return {
    output: null,
    source: "none",
    repaired: false,
    validationErrors: finalErrors,
  };
}

export function validateOutputContract(
  output: StructuredOutput,
  schema?: AgentOutputSchema
): string[] {
  try {
    validateStructuredOutput(output, schema);
    return [];
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }
}

function salvageStructuredOutput(
  currentOutput: StructuredOutput | null,
  input: StructuredOutputPostprocessInput,
  schema: AgentOutputSchema
): StructuredOutput | null {
  const allowed = new Set(getAllowedOutputBlocks(schema));
  const preferred = getPreferredOutputBlocks(schema);
  const required = getRequiredOutputBlocks(schema);
  const baseBlocks = (currentOutput?.blocks ?? []).filter((block) => allowed.has(block.type));
  const toolBlocks = input.toolCalls
    .flatMap((toolCall) => toolCall.ui?.blocks ?? [])
    .filter((block) => allowed.has(block.type));

  const selected: StructuredOutputBlock[] = [];

  for (const block of baseBlocks) {
    pushUniqueBlock(selected, block);
  }

  for (const blockType of required) {
    if (!selected.some((block) => block.type === blockType)) {
      const match = toolBlocks.find((block) => block.type === blockType);
      if (match) {
        pushUniqueBlock(selected, match);
      }
    }
  }

  if (selected.length === 0) {
    for (const blockType of preferred) {
      for (const block of toolBlocks.filter((entry) => entry.type === blockType)) {
        pushUniqueBlock(selected, block);
      }
    }
  }

  if (selected.length === 0 && required.length === 0) {
    for (const block of toolBlocks) {
      pushUniqueBlock(selected, block);
      if (selected.length >= 3) break;
    }
  }

  if (schema.requireCitations && !selected.some(blockContainsCitations)) {
    const citedBlock = toolBlocks.find(blockContainsCitations);
    if (citedBlock) {
      pushUniqueBlock(selected, citedBlock);
    }
  }

  if (required.length > 0) {
    const missingRequired = findMissingRequiredBlocks({
      version: 1,
      summary: currentOutput?.summary ?? summarize(input.result),
      blocks: selected,
    }, schema);

    if (missingRequired.length > 0) {
      for (const blockType of missingRequired) {
        const match = toolBlocks.find((block) => block.type === blockType);
        if (match) {
          pushUniqueBlock(selected, match);
        }
      }
    }
  }

  if (selected.length === 0) {
    return null;
  }

  return {
    version: 1,
    summary: currentOutput?.summary ?? summarize(input.result),
    blocks: selected,
  };
}

function pushUniqueBlock(target: StructuredOutputBlock[], block: StructuredOutputBlock): void {
  const signature = JSON.stringify(block);
  if (!target.some((item) => JSON.stringify(item) === signature)) {
    target.push(block);
  }
}

function blockContainsCitations(block: StructuredOutputBlock): boolean {
  switch (block.type) {
    case "cards":
      return block.cards.some((card) => (card.citations?.length ?? 0) > 0);
    case "table":
      return (block.citations?.length ?? 0) > 0;
    case "timeline":
      return block.items.some((item) => (item.citations?.length ?? 0) > 0);
    case "citations":
      return block.citations.length > 0;
    default:
      return false;
  }
}

function summarize(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
}
