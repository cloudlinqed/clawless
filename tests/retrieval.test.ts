import { afterEach, describe, expect, it } from "vitest";
import { defineAgent } from "../src/config/agent-def.js";
import { addKnowledge, deleteKnowledge, buildSystemPrompt } from "../src/config/knowledge.js";
import { retrieveAgentContext } from "../src/retrieval/index.js";
import { registerRetriever } from "../src/retrieval/registry.js";

describe("retrieval", () => {
  afterEach(() => {
    deleteKnowledge("retrieval-policy");
    deleteKnowledge("retrieval-catalog");
  });

  it("retrieves indexed knowledge chunks instead of injecting all static knowledge", async () => {
    addKnowledge({
      id: "retrieval-policy",
      agent: "retrieval-agent",
      title: "Return Policy",
      content: "Customers can return footwear within 30 days if the original tags are attached and the shoes are unworn.",
      priority: 10,
    });
    addKnowledge({
      id: "retrieval-catalog",
      agent: "retrieval-agent",
      title: "Catalog Notes",
      content: "The spring catalog highlights lightweight trail shoes, waterproof boots, and bundle discounts.",
      priority: 20,
    });

    const agent = defineAgent({
      name: "retrieval-agent",
      instructions: "You help with shopping questions.",
      tools: [],
      retrieval: {
        mode: "indexed",
        topK: 2,
      },
    });

    const documents = await retrieveAgentContext("What is the return policy for shoes?", agent);
    expect(documents.length).toBeGreaterThan(0);
    expect(documents[0]?.title).toContain("Return Policy");

    const prompt = buildSystemPrompt(agent, agent.instructions, { retrievedContext: documents });
    expect(prompt).toContain("# Retrieved Context");
    expect(prompt).not.toContain("# Knowledge & Skills");
    expect(prompt).toContain("Customers can return footwear within 30 days");
  });

  it("supports custom pluggable retrievers", async () => {
    registerRetriever({
      name: "catalog_rag_test",
      description: "Synthetic catalog retriever for tests",
      retrieve: async ({ query }) => [{
        id: "catalog-doc-1",
        title: "Catalog Search Result",
        content: `Matched catalog context for: ${query}`,
        score: 0.91,
        sourceType: "retriever",
        sourceName: "catalog_rag_test",
        url: "https://example.com/catalog-doc-1",
      }],
    });

    const agent = defineAgent({
      name: "custom-rag-agent",
      instructions: "You answer product questions with retrieved catalog context.",
      tools: [],
      retrieval: {
        mode: "indexed",
        sources: [
          { type: "retriever", name: "catalog_rag_test", topK: 1 },
        ],
      },
    });

    const documents = await retrieveAgentContext("waterproof boots", agent);
    expect(documents).toHaveLength(1);
    expect(documents[0]?.sourceName).toBe("catalog_rag_test");
    expect(documents[0]?.content).toContain("waterproof boots");
  });
});
