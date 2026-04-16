import { describe, expect, it } from "vitest";
import { adaptToolResultToOutput } from "../src/output/tool-result-adapter.js";

describe("adaptToolResultToOutput", () => {
  it("maps search-style results to citations", () => {
    const output = adaptToolResultToOutput({
      toolName: "web_search",
      toolLabel: "Web Search",
      resultText: JSON.stringify([
        {
          title: "Example Source",
          url: "https://example.com/article",
          snippet: "A short summary",
        },
      ]),
    });

    expect(output).not.toBeNull();
    expect(output?.blocks[0]?.type).toBe("citations");
    if (output?.blocks[0]?.type === "citations") {
      expect(output.blocks[0].citations[0]?.title).toBe("Example Source");
    }
  });

  it("maps record arrays to tables", () => {
    const output = adaptToolResultToOutput({
      toolName: "json_request",
      toolLabel: "Inventory API",
      resultText: JSON.stringify({
        status: 200,
        statusText: "OK",
        data: [
          { sku: "A-1", stock: 12, active: true },
          { sku: "B-2", stock: 5, active: false },
        ],
      }),
    });

    expect(output).not.toBeNull();
    expect(output?.summary).toContain("HTTP 200 OK");
    expect(output?.blocks[0]?.type).toBe("table");
    if (output?.blocks[0]?.type === "table") {
      expect(output.blocks[0].columns.map((column) => column.key)).toEqual(["sku", "stock", "active"]);
      expect(output.blocks[0].rows).toHaveLength(2);
    }
  });

  it("maps canonical form payloads directly to form blocks", () => {
    const output = adaptToolResultToOutput({
      toolName: "json_request",
      toolLabel: "Checkout Schema",
      resultText: JSON.stringify({
        title: "Checkout",
        fields: [
          { name: "email", label: "Email", type: "email", required: true },
          { name: "phone", label: "Phone", type: "tel" },
        ],
        actions: [
          { id: "submit", label: "Submit", kind: "primary" },
        ],
      }),
    });

    expect(output).not.toBeNull();
    expect(output?.blocks[0]?.type).toBe("form");
    if (output?.blocks[0]?.type === "form") {
      expect(output.blocks[0].fields).toHaveLength(2);
      expect(output.blocks[0].actions?.[0]?.label).toBe("Submit");
    }
  });
});
