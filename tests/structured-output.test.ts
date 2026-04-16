import { describe, expect, it } from "vitest";
import { buildStructuredOutputTool } from "../src/output/tool.js";
import { validateStructuredOutput } from "../src/output/schema.js";

describe("structured output", () => {
  it("validates allowed block types and required citations", () => {
    const output = validateStructuredOutput({
      version: 1,
      summary: "Found two products.",
      blocks: [
        {
          type: "cards",
          cards: [
            {
              title: "Trail Runner Pro",
              description: "Lightweight waterproof hiking shoe",
              citations: [
                {
                  title: "Catalog",
                  url: "https://example.com/products/trail-runner-pro",
                },
              ],
            },
          ],
        },
      ],
    }, {
      allowedBlocks: ["cards", "citations"],
      requireCitations: true,
    });

    expect(output.blocks[0]?.type).toBe("cards");
  });

  it("rejects blocks that are not allowed for the agent", () => {
    expect(() => validateStructuredOutput({
      version: 1,
      blocks: [
        {
          type: "table",
          columns: [{ key: "name", label: "Name" }],
          rows: [{ name: "Value" }],
        },
      ],
    }, {
      allowedBlocks: ["cards"],
    })).toThrow(/not allowed/i);
  });

  it("builds a present_output tool that returns validated JSON", async () => {
    const tool = buildStructuredOutputTool({
      outputSchema: {
        mode: "required",
        allowedBlocks: ["table", "actions"],
      },
    });

    expect(tool).not.toBeNull();

    const result = await (tool as any).execute("call-1", {
      version: 1,
      blocks: [
        {
          type: "table",
          columns: [{ key: "product", label: "Product" }],
          rows: [{ product: "Boots" }],
        },
      ],
    });

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(JSON.parse(text)).toEqual({
      version: 1,
      blocks: [
        {
          type: "table",
          columns: [{ key: "product", label: "Product" }],
          rows: [{ product: "Boots" }],
        },
      ],
    });
  });
});
