import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  clearRegisteredBlocks,
  getAllBlockTypes,
  getRegisteredBlock,
  getRegisteredBlockTypes,
  registerBlock,
} from "../src/output/block-registry.js";
import {
  getAllowedOutputBlocks,
  getStructuredOutputBlockSchema,
  validateStructuredOutput,
} from "../src/output/schema.js";
import { adaptToolResultToOutput } from "../src/output/tool-result-adapter.js";
import { buildStructuredOutputTool } from "../src/output/tool.js";

const ChartBlock = z.object({
  type: z.literal("chart"),
  title: z.string().optional(),
  chartType: z.enum(["line", "bar", "pie"]),
  xKey: z.string(),
  yKey: z.string(),
  data: z.array(z.record(z.string(), z.union([z.string(), z.number()]))).min(1),
});

const MapBlock = z.object({
  type: z.literal("map"),
  title: z.string().optional(),
  points: z.array(z.object({
    lat: z.number(),
    lng: z.number(),
    label: z.string().optional(),
  })).min(1),
});

function registerChart() {
  registerBlock({
    type: "chart",
    schema: ChartBlock,
    toolDescription:
      "Chart block. Required fields: chartType ('line'|'bar'|'pie'), xKey, yKey, data (array of objects with xKey/yKey values).",
    adaptFromTool: (value) => {
      if (!value || typeof value !== "object") return null;
      const record = value as Record<string, unknown>;
      if (record.chartType && Array.isArray(record.data) && record.xKey && record.yKey) {
        return { type: "chart", ...record };
      }
      return null;
    },
  });
}

describe("block registry", () => {
  afterEach(() => {
    clearRegisteredBlocks();
  });

  it("registers a custom block and reports it in the merged type list", () => {
    registerChart();
    expect(getRegisteredBlockTypes()).toContain("chart");
    expect(getAllBlockTypes()).toContain("chart");
    expect(getAllBlockTypes()).toContain("cards");
    expect(getRegisteredBlock("chart")?.type).toBe("chart");
  });

  it("rejects collision with a built-in block type", () => {
    expect(() =>
      registerBlock({
        type: "cards",
        schema: z.object({ type: z.literal("cards" as any) }) as any,
        toolDescription: "should fail",
      } as any)
    ).toThrow(/built-in/i);
  });

  it("rejects duplicate custom registration", () => {
    registerChart();
    expect(() => registerChart()).toThrow(/already registered/i);
  });

  it("rejects invalid block type names", () => {
    expect(() =>
      registerBlock({
        type: "bad type!",
        schema: z.object({ type: z.literal("bad type!" as any) }) as any,
        toolDescription: "nope",
      } as any)
    ).toThrow(/must start with a letter/i);
  });

  it("widens the default allowed block list to include registered blocks", () => {
    registerChart();
    const allowed = getAllowedOutputBlocks();
    expect(allowed).toContain("chart");
    expect(allowed).toContain("markdown");
  });

  it("validates output that uses a registered block when the agent allows it", () => {
    registerChart();
    const output = validateStructuredOutput({
      version: 1,
      summary: "Revenue by month",
      blocks: [
        {
          type: "chart",
          chartType: "line",
          xKey: "month",
          yKey: "revenue",
          data: [
            { month: "Jan", revenue: 120 },
            { month: "Feb", revenue: 140 },
          ],
        },
      ],
    }, {
      allowedBlocks: ["chart"],
    });

    expect(output.blocks[0]?.type).toBe("chart");
  });

  it("rejects a registered block that is not in the agent's allow list", () => {
    registerChart();
    expect(() =>
      validateStructuredOutput({
        version: 1,
        blocks: [
          {
            type: "chart",
            chartType: "bar",
            xKey: "a",
            yKey: "b",
            data: [{ a: "x", b: 1 }],
          },
        ],
      }, {
        allowedBlocks: ["cards"],
      })
    ).toThrow(/not allowed/i);
  });

  it("rejects a registered block that fails its own schema", () => {
    registerChart();
    expect(() =>
      validateStructuredOutput({
        version: 1,
        blocks: [
          {
            type: "chart",
            chartType: "scatter",
            xKey: "x",
            yKey: "y",
            data: [{ x: "a", y: 1 }],
          },
        ],
      }, {
        allowedBlocks: ["chart"],
      })
    ).toThrow();
  });

  it("lets the tool-result adapter turn matching tool JSON into a custom block", () => {
    registerChart();
    const resultText = JSON.stringify({
      chartType: "bar",
      xKey: "day",
      yKey: "visits",
      data: [
        { day: "Mon", visits: 10 },
        { day: "Tue", visits: 14 },
      ],
    });

    const output = adaptToolResultToOutput({
      toolName: "get_traffic",
      toolLabel: "Get Traffic",
      resultText,
    });

    expect(output?.blocks[0]?.type).toBe("chart");
  });

  it("skips custom adapters that return null and falls back to generic inference", () => {
    registerBlock({
      type: "map",
      schema: MapBlock,
      toolDescription: "Map block with geo points.",
      adaptFromTool: (value) => {
        if (value && typeof value === "object" && Array.isArray((value as any).points)) {
          return { type: "map", ...(value as any) };
        }
        return null;
      },
    });

    const output = adaptToolResultToOutput({
      toolName: "search",
      toolLabel: "Search",
      resultText: JSON.stringify([
        { title: "Item", url: "https://example.com/1" },
      ]),
    });

    expect(output?.blocks[0]?.type).not.toBe("map");
  });

  it("exposes custom block descriptions through the present_output tool", () => {
    registerChart();
    const tool = buildStructuredOutputTool({
      outputSchema: {
        mode: "required",
        allowedBlocks: ["chart"],
      },
    });

    expect(tool?.description ?? "").toContain("chart");
    expect(tool?.description ?? "").toContain("chartType");
  });

  it("getStructuredOutputBlockSchema returns a union that includes custom blocks", () => {
    registerChart();
    const schema = getStructuredOutputBlockSchema();
    const parsed = schema.safeParse({
      type: "chart",
      chartType: "pie",
      xKey: "label",
      yKey: "value",
      data: [{ label: "A", value: 1 }],
    });
    expect(parsed.success).toBe(true);
  });
});
