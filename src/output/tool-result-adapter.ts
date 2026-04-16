import {
  StructuredOutputSchema,
  createMarkdownFallbackOutput,
  parseStructuredOutputText,
  type OutputAction,
  type OutputCitation,
  type StructuredOutput,
  type StructuredOutputBlock,
} from "./schema.js";

export interface ToolResultAdapterInput {
  toolName: string;
  toolLabel?: string;
  args?: Record<string, unknown>;
  resultText: string;
  isError?: boolean;
}

type JsonRecord = Record<string, unknown>;

export function adaptToolResultToOutput(input: ToolResultAdapterInput): StructuredOutput | null {
  if (input.isError) {
    return null;
  }

  const trimmed = input.resultText.trim();
  if (!trimmed) {
    return null;
  }

  const directStructured = tryParseStructuredOutput(trimmed);
  if (directStructured) {
    return directStructured;
  }

  if (input.toolName === "fetch_page") {
    return finalizeOutput(
      [
        {
          type: "markdown",
          title: input.toolLabel ?? humanizeToolName(input.toolName),
          markdown: buildFetchPageMarkdown(input),
        },
      ],
      summarizeText(trimmed)
    );
  }

  const parsed = tryParseJson(trimmed);
  if (parsed === undefined) {
    return createMarkdownFallbackOutput(truncateText(trimmed, 5000));
  }

  const { value, summaryPrefix } = unwrapEnvelope(parsed);

  const known = adaptKnownToolResult(input, value, summaryPrefix);
  if (known) {
    return known;
  }

  const generic = adaptGenericValue(value, {
    title: input.toolLabel ?? humanizeToolName(input.toolName),
    summaryPrefix,
  });

  if (generic) {
    return generic;
  }

  return createMarkdownFallbackOutput(truncateText(trimmed, 5000));
}

function adaptKnownToolResult(
  input: ToolResultAdapterInput,
  value: unknown,
  summaryPrefix?: string
): StructuredOutput | null {
  switch (input.toolName) {
    case "web_search":
      return adaptSearchResults(value, input.toolLabel ?? "Search Results", summaryPrefix);
    case "current_datetime":
      return adaptCurrentDatetime(value, input.toolLabel ?? "Current Date/Time");
    case "json_request":
      return adaptGenericValue(value, {
        title: input.toolLabel ?? "API Result",
        summaryPrefix,
      });
    default:
      return null;
  }
}

function adaptSearchResults(value: unknown, title: string, summaryPrefix?: string): StructuredOutput | null {
  const items = Array.isArray(value) ? value : [];
  const citations = items
    .map((item) => mapCitation(item))
    .filter((item): item is OutputCitation => item !== null)
    .slice(0, 10);

  if (citations.length === 0) {
    return null;
  }

  return finalizeOutput(
    [
      {
        type: "citations",
        title,
        citations,
      },
    ],
    buildSummary(summaryPrefix, `${citations.length} search result${citations.length === 1 ? "" : "s"}`)
  );
}

function adaptCurrentDatetime(value: unknown, title: string): StructuredOutput | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const cardTitle = scalarToString(record.formatted) ?? title;
  const fields = collectFields(record, new Set(["formatted"]));
  return finalizeOutput(
    [
      {
        type: "cards",
        title,
        cards: [
          {
            title: cardTitle,
            fields,
          },
        ],
      },
    ],
    scalarToString(record.iso) ?? scalarToString(record.formatted)
  );
}

function adaptGenericValue(
  value: unknown,
  options: { title: string; summaryPrefix?: string }
): StructuredOutput | null {
  const canonical = adaptCanonicalBlocks(value, options.title);
  if (canonical) {
    return finalizeOutput(canonical.blocks, buildSummary(options.summaryPrefix, canonical.summary));
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return finalizeOutput(
        [
          {
            type: "markdown",
            title: options.title,
            markdown: "_No results returned._",
          },
        ],
        buildSummary(options.summaryPrefix, "No results")
      );
    }

    const citations = value
      .map((item) => mapCitation(item))
      .filter((item): item is OutputCitation => item !== null)
      .slice(0, 10);
    if (citations.length === value.length && citations.length > 0) {
      return finalizeOutput(
        [
          {
            type: "citations",
            title: options.title,
            citations,
          },
        ],
        buildSummary(options.summaryPrefix, `${citations.length} source${citations.length === 1 ? "" : "s"}`)
      );
    }

    const timeline = value
      .map((item) => mapTimelineItem(item))
      .filter((item): item is NonNullable<ReturnType<typeof mapTimelineItem>> => item !== null)
      .slice(0, 20);
    if (timeline.length === value.length && timeline.length > 0) {
      return finalizeOutput(
        [
          {
            type: "timeline",
            title: options.title,
            items: timeline,
          },
        ],
        buildSummary(options.summaryPrefix, `${timeline.length} timeline item${timeline.length === 1 ? "" : "s"}`)
      );
    }

    const cards = value
      .map((item) => mapCard(item))
      .filter((item): item is NonNullable<ReturnType<typeof mapCard>> => item !== null)
      .slice(0, 12);
    if (cards.length === value.length && cards.length > 0) {
      return finalizeOutput(
        [
          {
            type: "cards",
            title: options.title,
            cards,
          },
        ],
        buildSummary(options.summaryPrefix, `${cards.length} card${cards.length === 1 ? "" : "s"}`)
      );
    }

    const table = adaptTableFromArray(value, options.title);
    if (table) {
      return finalizeOutput(
        [table],
        buildSummary(options.summaryPrefix, `${table.rows.length} row${table.rows.length === 1 ? "" : "s"}`)
      );
    }

    return createMarkdownFallbackOutput(truncateText(JSON.stringify(value, null, 2), 5000));
  }

  const record = asRecord(value);
  if (record) {
    const citation = mapCitation(record);
    if (citation) {
      return finalizeOutput(
        [
          {
            type: "citations",
            title: options.title,
            citations: [citation],
          },
        ],
        buildSummary(options.summaryPrefix, "1 source")
      );
    }

    const card = mapCard(record);
    if (card) {
      return finalizeOutput(
        [
          {
            type: "cards",
            title: options.title,
            cards: [card],
          },
        ],
        buildSummary(options.summaryPrefix, "1 record")
      );
    }

    const fields = collectFields(record);
    if (fields.length > 0) {
      return finalizeOutput(
        [
          {
            type: "cards",
            title: options.title,
            cards: [
              {
                title: options.title,
                fields,
              },
            ],
          },
        ],
        buildSummary(options.summaryPrefix, `${fields.length} field${fields.length === 1 ? "" : "s"}`)
      );
    }
  }

  if (typeof value === "string") {
    return createMarkdownFallbackOutput(truncateText(value, 5000));
  }

  return createMarkdownFallbackOutput(truncateText(JSON.stringify(value, null, 2), 5000));
}

function adaptCanonicalBlocks(
  value: unknown,
  title: string
): { blocks: StructuredOutputBlock[]; summary?: string } | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const actions = Array.isArray(record.actions)
    ? record.actions.map((item) => mapAction(item)).filter((item): item is OutputAction => item !== null)
    : [];

  if (Array.isArray(record.fields) && record.fields.every(looksLikeFormField)) {
    return {
      blocks: [
        {
          type: "form",
          title: scalarToString(record.title) ?? title,
          description: scalarToString(record.description),
          submitLabel: scalarToString(record.submitLabel),
          fields: record.fields as any,
          actions: actions.length > 0 ? actions : undefined,
        },
      ],
      summary: `${record.fields.length} form field${record.fields.length === 1 ? "" : "s"}`,
    };
  }

  if (Array.isArray(record.filters) && record.filters.every(looksLikeFilter)) {
    return {
      blocks: [
        {
          type: "filters",
          title: scalarToString(record.title) ?? title,
          filters: record.filters as any,
        },
      ],
      summary: `${record.filters.length} filter${record.filters.length === 1 ? "" : "s"}`,
    };
  }

  if (actions.length > 0 && Object.keys(record).every((key) => key === "actions" || key === "title")) {
    return {
      blocks: [
        {
          type: "actions",
          title: scalarToString(record.title) ?? title,
          actions,
        },
      ],
      summary: `${actions.length} action${actions.length === 1 ? "" : "s"}`,
    };
  }

  if (Array.isArray(record.items)) {
    const items = record.items
      .map((item) => mapTimelineItem(item))
      .filter((item): item is NonNullable<ReturnType<typeof mapTimelineItem>> => item !== null);
    if (items.length === record.items.length && items.length > 0) {
      return {
        blocks: [
          {
            type: "timeline",
            title: scalarToString(record.title) ?? title,
            items,
          },
        ],
        summary: `${items.length} timeline item${items.length === 1 ? "" : "s"}`,
      };
    }
  }

  if (Array.isArray(record.cards)) {
    const cards = record.cards
      .map((item) => mapCard(item))
      .filter((item): item is NonNullable<ReturnType<typeof mapCard>> => item !== null);
    if (cards.length === record.cards.length && cards.length > 0) {
      return {
        blocks: [
          {
            type: "cards",
            title: scalarToString(record.title) ?? title,
            cards,
          },
        ],
        summary: `${cards.length} card${cards.length === 1 ? "" : "s"}`,
      };
    }
  }

  if (Array.isArray(record.citations)) {
    const citations = record.citations
      .map((item) => mapCitation(item))
      .filter((item): item is OutputCitation => item !== null);
    if (citations.length === record.citations.length && citations.length > 0) {
      return {
        blocks: [
          {
            type: "citations",
            title: scalarToString(record.title) ?? title,
            citations,
          },
        ],
        summary: `${citations.length} source${citations.length === 1 ? "" : "s"}`,
      };
    }
  }

  return null;
}

function adaptTableFromArray(value: unknown[], title: string) {
  const rows = value
    .map((item) => asRecord(item))
    .filter((item): item is JsonRecord => item !== null);
  if (rows.length !== value.length || rows.length === 0) {
    return null;
  }

  const columnKeys = Array.from(
    rows.reduce((keys, row) => {
      for (const [key, itemValue] of Object.entries(row)) {
        if (isPrimitive(itemValue)) {
          keys.add(key);
        }
      }
      return keys;
    }, new Set<string>())
  ).slice(0, 8);

  if (columnKeys.length === 0) {
    return null;
  }

  const columns = columnKeys.map((key) => ({
    key,
    label: humanizeToolName(key),
  }));

  const tableRows = rows.slice(0, 20).map((row) => {
    const outputRow: Record<string, string | number | boolean | null> = {};
    for (const key of columnKeys) {
      outputRow[key] = toPrimitive(row[key]);
    }
    return outputRow;
  });

  return {
    type: "table" as const,
    title,
    columns,
    rows: tableRows,
  };
}

function mapCitation(value: unknown): OutputCitation | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const title = scalarToString(record.title) ?? scalarToString(record.name) ?? scalarToString(record.headline);
  const url = scalarToString(record.url) ?? scalarToString(record.link) ?? scalarToString(record.href);
  if (!title || !url || !looksLikeUrl(url)) {
    return null;
  }

  return {
    id: scalarToString(record.id),
    title,
    url,
    snippet:
      scalarToString(record.snippet) ??
      scalarToString(record.description) ??
      scalarToString(record.summary) ??
      scalarToString(record.text),
    source: scalarToString(record.source) ?? scalarToString(record.domain),
    publishedAt:
      scalarToString(record.publishedAt) ??
      scalarToString(record.published_at) ??
      scalarToString(record.date),
  };
}

function mapCard(value: unknown) {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const title = scalarToString(record.title) ?? scalarToString(record.name);
  if (!title) {
    return null;
  }

  const actions = Array.isArray(record.actions)
    ? record.actions.map((item) => mapAction(item)).filter((item): item is OutputAction => item !== null)
    : undefined;

  const citations = Array.isArray(record.citations)
    ? record.citations.map((item) => mapCitation(item)).filter((item): item is OutputCitation => item !== null)
    : undefined;

  return {
    id: scalarToString(record.id),
    title,
    description:
      scalarToString(record.description) ??
      scalarToString(record.summary) ??
      scalarToString(record.snippet),
    value:
      scalarToString(record.value) ??
      scalarToString(record.price) ??
      scalarToString(record.amount),
    badge: scalarToString(record.badge) ?? scalarToString(record.status),
    imageUrl: getOptionalUrl(record.imageUrl) ?? getOptionalUrl(record.image) ?? getOptionalUrl(record.thumbnail),
    url: getOptionalUrl(record.url) ?? getOptionalUrl(record.link) ?? getOptionalUrl(record.href),
    fields: collectFields(record, new Set([
      "id",
      "title",
      "name",
      "description",
      "summary",
      "snippet",
      "value",
      "price",
      "amount",
      "badge",
      "status",
      "imageUrl",
      "image",
      "thumbnail",
      "url",
      "link",
      "href",
      "actions",
      "citations",
    ])),
    actions: actions && actions.length > 0 ? actions : undefined,
    citations: citations && citations.length > 0 ? citations : undefined,
  };
}

function mapAction(value: unknown): OutputAction | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const label = scalarToString(record.label) ?? scalarToString(record.title) ?? scalarToString(record.name);
  if (!label) {
    return null;
  }

  return {
    id: scalarToString(record.id) ?? slugify(label),
    label,
    kind: asActionKind(record.kind),
    url: getOptionalUrl(record.url) ?? getOptionalUrl(record.href),
    payload: isRecordLike(record.payload) ? record.payload : undefined,
    disabled: typeof record.disabled === "boolean" ? record.disabled : undefined,
  };
}

function mapTimelineItem(value: unknown) {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const title = scalarToString(record.title) ?? scalarToString(record.name);
  const time =
    scalarToString(record.time) ??
    scalarToString(record.date) ??
    scalarToString(record.datetime) ??
    scalarToString(record.timestamp);
  if (!title || !time) {
    return null;
  }

  const actions = Array.isArray(record.actions)
    ? record.actions.map((item) => mapAction(item)).filter((item): item is OutputAction => item !== null)
    : undefined;

  const citations = Array.isArray(record.citations)
    ? record.citations.map((item) => mapCitation(item)).filter((item): item is OutputCitation => item !== null)
    : undefined;

  return {
    id: scalarToString(record.id),
    title,
    subtitle: scalarToString(record.subtitle),
    description: scalarToString(record.description) ?? scalarToString(record.summary),
    time,
    status: scalarToString(record.status),
    actions: actions && actions.length > 0 ? actions : undefined,
    citations: citations && citations.length > 0 ? citations : undefined,
  };
}

function buildFetchPageMarkdown(input: ToolResultAdapterInput): string {
  const source = scalarToString(input.args?.url);
  const header = source ? `Source: ${source}\n\n` : "";
  return `${header}${truncateText(input.resultText, 5000)}`;
}

function unwrapEnvelope(value: unknown): { value: unknown; summaryPrefix?: string } {
  const record = asRecord(value);
  if (!record) {
    return { value };
  }

  if ("data" in record) {
    const summaryParts = [
      "status" in record ? scalarToString(record.status) : undefined,
      "statusText" in record ? scalarToString(record.statusText) : undefined,
    ].filter((part): part is string => Boolean(part));
    return {
      value: record.data,
      summaryPrefix: summaryParts.length > 0 ? `HTTP ${summaryParts.join(" ")}` : undefined,
    };
  }

  const arrayKeys = ["results", "items", "products", "records", "rows"];
  for (const key of arrayKeys) {
    if (Array.isArray(record[key])) {
      return {
        value: record[key],
        summaryPrefix: scalarToString(record.total) ?? scalarToString(record.count),
      };
    }
  }

  return { value };
}

function tryParseStructuredOutput(text: string): StructuredOutput | null {
  try {
    return parseStructuredOutputText(text);
  } catch {
    return null;
  }
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function finalizeOutput(blocks: StructuredOutputBlock[], summary?: string): StructuredOutput | null {
  try {
    return StructuredOutputSchema.parse({
      version: 1,
      summary,
      blocks,
    });
  } catch {
    return null;
  }
}

function collectFields(record: JsonRecord, exclude = new Set<string>()) {
  return Object.entries(record)
    .filter((entry): entry is [string, string | number | boolean | null] => (
      !exclude.has(entry[0]) && isPrimitive(entry[1])
    ))
    .map(([key, value]) => ({
      label: humanizeToolName(key),
      value: primitiveToString(value),
    }))
    .filter((field) => field.value.length > 0)
    .slice(0, 10);
}

function humanizeToolName(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function truncateText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function summarizeText(value: string): string {
  const line = value.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return truncateText(line, 120);
}

function buildSummary(prefix?: string, suffix?: string): string | undefined {
  const parts = [prefix, suffix].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" • ") : undefined;
}

function scalarToString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function primitiveToString(value: string | number | boolean | null): string {
  return value === null ? "null" : String(value);
}

function toPrimitive(value: unknown): string | number | boolean | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  return value === undefined ? null : truncateText(JSON.stringify(value), 200);
}

function asRecord(value: unknown): JsonRecord | null {
  return isRecordLike(value) ? value : null;
}

function isRecordLike(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPrimitive(value: unknown): value is string | number | boolean | null {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null;
}

function looksLikeUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function getOptionalUrl(value: unknown): string | undefined {
  const text = scalarToString(value);
  return text && looksLikeUrl(text) ? text : undefined;
}

function asActionKind(value: unknown): OutputAction["kind"] | undefined {
  return value === "primary" || value === "secondary" || value === "danger" || value === "link"
    ? value
    : undefined;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "action";
}

function looksLikeFormField(value: unknown): boolean {
  const record = asRecord(value);
  return Boolean(
    record &&
    scalarToString(record.name) &&
    scalarToString(record.label) &&
    scalarToString(record.type)
  );
}

function looksLikeFilter(value: unknown): boolean {
  const record = asRecord(value);
  return Boolean(
    record &&
    scalarToString(record.name) &&
    scalarToString(record.label) &&
    scalarToString(record.type)
  );
}
