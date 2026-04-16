import { z } from "zod";
import type { AgentOutputBlockType, AgentOutputSchema } from "../config/agent-def.js";

export const SUPPORTED_OUTPUT_BLOCK_TYPES = [
  "markdown",
  "cards",
  "table",
  "timeline",
  "form",
  "filters",
  "actions",
  "citations",
] as const satisfies readonly AgentOutputBlockType[];

const OutputBlockTypeSchema = z.enum(SUPPORTED_OUTPUT_BLOCK_TYPES);

const PrimitiveValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const OutputActionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(["primary", "secondary", "danger", "link"]).optional(),
  url: z.string().min(1).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  disabled: z.boolean().optional(),
});

export type OutputAction = z.infer<typeof OutputActionSchema>;

export const OutputCitationSchema = z.object({
  id: z.string().min(1).optional(),
  title: z.string().min(1),
  url: z.string().url(),
  snippet: z.string().optional(),
  source: z.string().optional(),
  publishedAt: z.string().optional(),
});

export type OutputCitation = z.infer<typeof OutputCitationSchema>;

const OutputFieldSchema = z.object({
  label: z.string().min(1),
  value: z.string().min(1),
});

const MarkdownBlockSchema = z.object({
  type: z.literal("markdown"),
  title: z.string().optional(),
  markdown: z.string().min(1),
});

const CardSchema = z.object({
  id: z.string().min(1).optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  value: z.string().optional(),
  badge: z.string().optional(),
  imageUrl: z.string().url().optional(),
  url: z.string().min(1).optional(),
  fields: z.array(OutputFieldSchema).optional(),
  actions: z.array(OutputActionSchema).optional(),
  citations: z.array(OutputCitationSchema).optional(),
});

const CardsBlockSchema = z.object({
  type: z.literal("cards"),
  title: z.string().optional(),
  cards: z.array(CardSchema).min(1),
});

const TableColumnSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  align: z.enum(["left", "center", "right"]).optional(),
});

const TableBlockSchema = z.object({
  type: z.literal("table"),
  title: z.string().optional(),
  columns: z.array(TableColumnSchema).min(1),
  rows: z.array(z.record(z.string(), PrimitiveValueSchema)),
  actions: z.array(OutputActionSchema).optional(),
  citations: z.array(OutputCitationSchema).optional(),
});

const TimelineItemSchema = z.object({
  id: z.string().min(1).optional(),
  title: z.string().min(1),
  subtitle: z.string().optional(),
  description: z.string().optional(),
  time: z.string().optional(),
  status: z.string().optional(),
  actions: z.array(OutputActionSchema).optional(),
  citations: z.array(OutputCitationSchema).optional(),
});

const TimelineBlockSchema = z.object({
  type: z.literal("timeline"),
  title: z.string().optional(),
  items: z.array(TimelineItemSchema).min(1),
});

const FormOptionSchema = z.object({
  label: z.string().min(1),
  value: z.string().min(1),
});

const FormFieldSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(["text", "textarea", "select", "number", "date", "email", "tel", "checkbox", "hidden"]),
  required: z.boolean().optional(),
  description: z.string().optional(),
  placeholder: z.string().optional(),
  value: PrimitiveValueSchema.optional(),
  options: z.array(FormOptionSchema).optional(),
});

const FormBlockSchema = z.object({
  type: z.literal("form"),
  title: z.string().optional(),
  description: z.string().optional(),
  submitLabel: z.string().optional(),
  fields: z.array(FormFieldSchema).min(1),
  actions: z.array(OutputActionSchema).optional(),
});

const FilterSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(["search", "select", "multi_select", "range", "boolean"]),
  value: z.union([PrimitiveValueSchema, z.array(z.string())]).optional(),
  options: z.array(FormOptionSchema).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
});

const FiltersBlockSchema = z.object({
  type: z.literal("filters"),
  title: z.string().optional(),
  filters: z.array(FilterSchema).min(1),
});

const ActionsBlockSchema = z.object({
  type: z.literal("actions"),
  title: z.string().optional(),
  actions: z.array(OutputActionSchema).min(1),
});

const CitationsBlockSchema = z.object({
  type: z.literal("citations"),
  title: z.string().optional(),
  citations: z.array(OutputCitationSchema).min(1),
});

export const StructuredOutputBlockSchema = z.discriminatedUnion("type", [
  MarkdownBlockSchema,
  CardsBlockSchema,
  TableBlockSchema,
  TimelineBlockSchema,
  FormBlockSchema,
  FiltersBlockSchema,
  ActionsBlockSchema,
  CitationsBlockSchema,
]);

export type StructuredOutputBlock = z.infer<typeof StructuredOutputBlockSchema>;

export const StructuredOutputSchema = z.object({
  version: z.literal(1).default(1),
  summary: z.string().optional(),
  blocks: z.array(StructuredOutputBlockSchema).min(1),
});

export type StructuredOutput = z.infer<typeof StructuredOutputSchema>;

export function getOutputSchemaMode(schema?: AgentOutputSchema): "auto" | "required" | "off" {
  return schema?.mode ?? "auto";
}

export function getAllowedOutputBlocks(schema?: AgentOutputSchema): AgentOutputBlockType[] {
  return schema?.allowedBlocks?.length
    ? [...schema.allowedBlocks]
    : [...SUPPORTED_OUTPUT_BLOCK_TYPES];
}

export function getPreferredOutputBlocks(schema?: AgentOutputSchema): AgentOutputBlockType[] {
  return schema?.preferredBlocks?.length ? [...schema.preferredBlocks] : [];
}

export function getRequiredOutputBlocks(schema?: AgentOutputSchema): AgentOutputBlockType[] {
  return schema?.requiredBlocks?.length ? [...schema.requiredBlocks] : [];
}

export function getOutputInvalidPolicy(schema?: AgentOutputSchema): "repair" | "reject" {
  if (schema?.onInvalid) {
    return schema.onInvalid;
  }
  return getOutputSchemaMode(schema) === "required" ? "reject" : "repair";
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

export function findMissingRequiredBlocks(
  output: StructuredOutput,
  schema?: AgentOutputSchema
): AgentOutputBlockType[] {
  const required = new Set(getRequiredOutputBlocks(schema));
  if (required.size === 0) {
    return [];
  }

  const present = new Set(output.blocks.map((block) => block.type));
  return Array.from(required).filter((blockType) => !present.has(blockType));
}

export function validateStructuredOutput(
  value: unknown,
  schema?: AgentOutputSchema
): StructuredOutput {
  const parsed = StructuredOutputSchema.parse(value);
  const allowedBlocks = new Set(getAllowedOutputBlocks(schema));

  for (const block of parsed.blocks) {
    if (!allowedBlocks.has(block.type)) {
      throw new Error(
        `Structured output block "${block.type}" is not allowed for this agent. Allowed: ${Array.from(allowedBlocks).join(", ")}`
      );
    }
  }

  if (schema?.requireCitations && !parsed.blocks.some(blockContainsCitations)) {
    throw new Error("Structured output requires citations for this agent");
  }

  const missingRequired = findMissingRequiredBlocks(parsed, schema);
  if (missingRequired.length > 0) {
    throw new Error(`Structured output is missing required block types: ${missingRequired.join(", ")}`);
  }

  return parsed;
}

export function isStructuredOutputEnabled(schema?: AgentOutputSchema): boolean {
  return Boolean(schema) && getOutputSchemaMode(schema) !== "off";
}

export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

export function parseStructuredOutputText(
  text: string,
  schema?: AgentOutputSchema
): StructuredOutput {
  const cleaned = stripCodeFence(text);
  return validateStructuredOutput(JSON.parse(cleaned), schema);
}

export function createMarkdownFallbackOutput(
  text: string,
  schema?: AgentOutputSchema
): StructuredOutput | null {
  const summary = text.trim();
  if (!summary) return null;

  const allowed = new Set(getAllowedOutputBlocks(schema));
  if (!allowed.has("markdown")) {
    return null;
  }

  return {
    version: 1,
    summary,
    blocks: [
      {
        type: "markdown",
        markdown: summary,
      },
    ],
  };
}

export function describeAllowedBlocks(schema?: AgentOutputSchema): string {
  return getAllowedOutputBlocks(schema).join(", ");
}

export function describePreferredBlocks(schema?: AgentOutputSchema): string {
  const preferred = getPreferredOutputBlocks(schema);
  return preferred.length > 0 ? preferred.join(", ") : "";
}

export function describeRequiredBlocks(schema?: AgentOutputSchema): string {
  const required = getRequiredOutputBlocks(schema);
  return required.length > 0 ? required.join(", ") : "";
}

export const StructuredOutputBlockTypeOnlySchema = OutputBlockTypeSchema;
