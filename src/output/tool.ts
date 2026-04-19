import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { AgentDef, AgentOutputSchema } from "../config/agent-def.js";
import { defineTool, Type } from "../tools/interface.js";
import {
  describeAllowedBlocks,
  describePreferredBlocks,
  describeRequiredBlocks,
  getOutputSchemaMode,
  isStructuredOutputEnabled,
  parseStructuredOutputText,
  validateStructuredOutput,
  type StructuredOutput,
} from "./schema.js";
import { getRegisteredBlocks } from "./block-registry.js";

const ActionSchema = Type.Object({
  id: Type.String({ description: "Stable action id" }),
  label: Type.String({ description: "Short action label" }),
  kind: Type.Optional(Type.String({ description: "Optional visual intent: primary, secondary, danger, link" })),
  url: Type.Optional(Type.String({ description: "Optional target URL" })),
  payload: Type.Optional(Type.Unknown({ description: "Optional structured payload for the frontend" })),
  disabled: Type.Optional(Type.Boolean({ description: "Whether the action should be disabled" })),
});

const CitationSchema = Type.Object({
  id: Type.Optional(Type.String({ description: "Optional citation id" })),
  title: Type.String({ description: "Citation title" }),
  url: Type.String({ description: "Citation URL" }),
  snippet: Type.Optional(Type.String({ description: "Short quoted or summarized snippet" })),
  source: Type.Optional(Type.String({ description: "Source label" })),
  publishedAt: Type.Optional(Type.String({ description: "Optional publish date or timestamp" })),
});

const FieldSchema = Type.Object({
  label: Type.String({ description: "Field label" }),
  value: Type.String({ description: "Field value" }),
});

const FormOptionSchema = Type.Object({
  label: Type.String({ description: "Option label" }),
  value: Type.String({ description: "Option value" }),
});

const BlockSchema = Type.Object({
  type: Type.String({
    description: "Block type: markdown | cards | table | timeline | form | filters | actions | citations",
  }),
  title: Type.Optional(Type.String({ description: "Optional block title" })),
  markdown: Type.Optional(Type.String({ description: "Markdown content for markdown blocks" })),
  cards: Type.Optional(Type.Array(Type.Object({
    id: Type.Optional(Type.String({ description: "Optional card id" })),
    title: Type.String({ description: "Card title" }),
    description: Type.Optional(Type.String({ description: "Card description" })),
    value: Type.Optional(Type.String({ description: "Primary value or metric" })),
    badge: Type.Optional(Type.String({ description: "Small badge label" })),
    imageUrl: Type.Optional(Type.String({ description: "Optional image URL" })),
    url: Type.Optional(Type.String({ description: "Optional card URL" })),
    fields: Type.Optional(Type.Array(FieldSchema, { description: "Optional key-value fields" })),
    actions: Type.Optional(Type.Array(ActionSchema, { description: "Optional card actions" })),
    citations: Type.Optional(Type.Array(CitationSchema, { description: "Optional card citations" })),
  }), { description: "Cards for cards blocks" })),
  columns: Type.Optional(Type.Array(Type.Object({
    key: Type.String({ description: "Stable row key" }),
    label: Type.String({ description: "Column label" }),
    align: Type.Optional(Type.String({ description: "Optional alignment: left, center, right" })),
  }), { description: "Columns for table blocks" })),
  rows: Type.Optional(Type.Array(Type.Record(
    Type.String(),
    Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()])
  ), { description: "Rows for table blocks" })),
  items: Type.Optional(Type.Array(Type.Object({
    id: Type.Optional(Type.String({ description: "Optional timeline item id" })),
    title: Type.String({ description: "Timeline item title" }),
    subtitle: Type.Optional(Type.String({ description: "Optional timeline subtitle" })),
    description: Type.Optional(Type.String({ description: "Timeline item description" })),
    time: Type.Optional(Type.String({ description: "Time, date, or sequence label" })),
    status: Type.Optional(Type.String({ description: "Optional status label" })),
    actions: Type.Optional(Type.Array(ActionSchema)),
    citations: Type.Optional(Type.Array(CitationSchema)),
  }), { description: "Timeline items" })),
  description: Type.Optional(Type.String({ description: "Optional description for form blocks" })),
  submitLabel: Type.Optional(Type.String({ description: "Form submit button label" })),
  fields: Type.Optional(Type.Array(Type.Object({
    name: Type.String({ description: "Field name" }),
    label: Type.String({ description: "Field label" }),
    type: Type.String({ description: "Field type: text, textarea, select, number, date, email, tel, checkbox, hidden" }),
    required: Type.Optional(Type.Boolean({ description: "Whether the field is required" })),
    description: Type.Optional(Type.String({ description: "Optional field help text" })),
    placeholder: Type.Optional(Type.String({ description: "Optional placeholder text" })),
    value: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()])),
    options: Type.Optional(Type.Array(FormOptionSchema)),
  }), { description: "Form fields" })),
  filters: Type.Optional(Type.Array(Type.Object({
    name: Type.String({ description: "Filter name" }),
    label: Type.String({ description: "Filter label" }),
    type: Type.String({ description: "Filter type: search, select, multi_select, range, boolean" }),
    value: Type.Optional(Type.Unknown({ description: "Current filter value" })),
    options: Type.Optional(Type.Array(FormOptionSchema)),
    min: Type.Optional(Type.Number({ description: "Range min" })),
    max: Type.Optional(Type.Number({ description: "Range max" })),
    step: Type.Optional(Type.Number({ description: "Range step" })),
  }), { description: "Filter controls" })),
  actions: Type.Optional(Type.Array(ActionSchema, { description: "Actions for actions blocks or table/form blocks" })),
  citations: Type.Optional(Type.Array(CitationSchema, { description: "Citations for citation blocks or other blocks" })),
});

function buildToolDescription(schema: AgentOutputSchema): string {
  const allowed = describeAllowedBlocks(schema);
  const preferred = describePreferredBlocks(schema);
  const mode = getOutputSchemaMode(schema);

  const allowedSet = new Set(allowed.split(",").map((entry) => entry.trim()));
  const customBlocks = getRegisteredBlocks().filter((block) => allowedSet.has(block.type));

  const lines = [
    "Create the UI-ready response payload for the current agent result.",
    "Use this instead of relying on the frontend to reverse-engineer cards, tables, timelines, forms, filters, actions, or citations from plain text.",
    `Allowed block types: ${allowed}.`,
  ];

  if (customBlocks.length > 0) {
    lines.push("Custom block shapes (produce these when they fit):");
    for (const block of customBlocks) {
      lines.push(`- ${block.type}: ${block.toolDescription}`);
    }
  }

  if (preferred) {
    lines.push(`Prefer these block types when they fit: ${preferred}.`);
  }

  const required = describeRequiredBlocks(schema);
  if (required) {
    lines.push(`Required block types: ${required}.`);
  }

  if (schema.requireCitations) {
    lines.push("Citations are required for this agent's structured output.");
  }

  if (schema.instructions) {
    lines.push(`Additional rules: ${schema.instructions}`);
  }

  if (mode === "required") {
    lines.push("This agent expects structured output on every substantive answer.");
  }

  return lines.join(" ");
}

export function buildStructuredOutputTool(agentDef: Pick<AgentDef, "outputSchema">): AgentTool<any, any> | null {
  if (!isStructuredOutputEnabled(agentDef.outputSchema)) {
    return null;
  }
  const schema = agentDef.outputSchema!;

  return defineTool({
    name: "present_output",
    label: "Present Output",
    description: buildToolDescription(schema),
    parameters: Type.Object({
      version: Type.Optional(Type.Number({ description: "Structured output version. Use 1." })),
      summary: Type.Optional(Type.String({ description: "Short textual summary of the final answer" })),
      blocks: Type.Array(BlockSchema, { description: "Ordered UI blocks to render" }),
    }),
    execute: async (params) => {
      const validated = validateStructuredOutput(params, schema);
      return JSON.stringify(validated, null, 2);
    },
  });
}

export function parseStructuredOutputResult(
  resultText: string,
  schema?: AgentOutputSchema
): StructuredOutput | null {
  try {
    return parseStructuredOutputText(resultText, schema);
  } catch {
    return null;
  }
}
