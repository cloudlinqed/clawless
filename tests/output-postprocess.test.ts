import { describe, expect, it } from "vitest";
import { finalizeStructuredOutput, StructuredOutputContractError } from "../src/output/postprocess.js";
import { validateStructuredOutput } from "../src/output/schema.js";

describe("output post-processing", () => {
  it("rejects structured output that is missing required block types", () => {
    expect(() => validateStructuredOutput({
      version: 1,
      blocks: [
        {
          type: "actions",
          actions: [
            { id: "next", label: "Next step" },
          ],
        },
      ],
    }, {
      allowedBlocks: ["cards", "actions"],
      requiredBlocks: ["cards"],
    })).toThrow(/missing required block types/i);
  });

  it("salvages required cards from tool UI when the direct output misses them", async () => {
    const result = await finalizeStructuredOutput(null as any, {
      prompt: "Show the products",
      result: "Trail Runner, Alpine Boot",
      currentOutput: {
        version: 1,
        blocks: [
          {
            type: "actions",
            actions: [
              { id: "refine", label: "Refine search" },
            ],
          },
        ],
      },
      toolCalls: [
        {
          name: "search_catalog",
          args: { query: "boots" },
          result: "{\"items\":[]}",
          isError: false,
          ui: {
            version: 1,
            blocks: [
              {
                type: "cards",
                title: "Products",
                cards: [
                  { title: "Trail Runner" },
                  { title: "Alpine Boot" },
                ],
              },
            ],
          },
        },
      ],
    }, {
      mode: "required",
      allowedBlocks: ["cards", "actions"],
      requiredBlocks: ["cards"],
      onInvalid: "repair",
    });

    expect(result.output).not.toBeNull();
    expect(result.source).toBe("salvaged");
    expect(result.repaired).toBe(true);
    expect(result.output?.blocks.some((block) => block.type === "cards")).toBe(true);
  });

  it("rejects when required output cannot be satisfied", async () => {
    await expect(finalizeStructuredOutput(null as any, {
      prompt: "Show product cards",
      result: "Product A, Product B",
      toolCalls: [],
    }, {
      mode: "required",
      allowedBlocks: ["cards"],
      requiredBlocks: ["cards"],
      onInvalid: "reject",
    })).rejects.toBeInstanceOf(StructuredOutputContractError);
  });
});
