import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgentFor, upsertRuntimeAgentConfig } from "../src/config/agent-def.js";
import {
  getConfigSnapshot,
  initializeConfigLifecycle,
  listConfigReleases,
  promoteConfig,
  publishDraft,
  resetConfigLifecycleForTests,
  rollbackConfig,
} from "../src/config/lifecycle.js";
import { addKnowledge, listKnowledge } from "../src/config/knowledge.js";
import { registerTool, listTools } from "../src/config/tool-store.js";

describe("config lifecycle", () => {
  beforeEach(async () => {
    resetConfigLifecycleForTests();
    await initializeConfigLifecycle({
      agents: [
        {
          name: "shop",
          instructions: "Published shopping agent",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      knowledge: [
        {
          id: "base-knowledge",
          agent: "shop",
          title: "Store Policy",
          content: "Only discuss shopping topics.",
          priority: 10,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      tools: [
        {
          name: "search_products",
          agent: "shop",
          description: "Search products",
          method: "GET",
          url: "https://api.example.com/products",
          parameters: {
            query: { type: "string", description: "Search query", required: true },
          },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
  });

  afterEach(() => {
    resetConfigLifecycleForTests();
  });

  it("keeps draft changes separate until publish", () => {
    const environment = "qa";

    const knowledgeResult = addKnowledge({
      agent: "shop",
      title: "Draft Merchandising",
      content: "Highlight seasonal bundles first.",
      priority: 20,
    }, { environment });
    expect(knowledgeResult.ok).toBe(true);

    const toolResult = registerTool({
      name: "lookup_inventory",
      description: "Lookup inventory",
      method: "GET",
      url: "https://api.example.com/inventory",
      parameters: {
        sku: { type: "string", description: "SKU", required: true },
      },
    }, "shop", { environment });
    expect(toolResult.ok).toBe(true);

    const agentResult = upsertRuntimeAgentConfig({
      name: "shop",
      instructions: "Draft shopping agent with bundle-first policy",
    }, { environment });
    expect(agentResult.ok).toBe(true);

    expect(listKnowledge("shop", { environment, stage: "draft" })).toHaveLength(2);
    expect(listKnowledge("shop", { environment, stage: "published" })).toHaveLength(1);
    expect(listTools("shop", { environment, stage: "draft" })).toHaveLength(2);
    expect(listTools("shop", { environment, stage: "published" })).toHaveLength(1);
    expect(getAgentFor("shop", { environment, stage: "draft" })?.instructions).toContain("bundle-first");
    expect(getAgentFor("shop", { environment, stage: "published" })?.instructions).toBe("Published shopping agent");

    const release = publishDraft({ environment, note: "QA release 2" });
    expect(release.version).toBe(2);
    expect(listKnowledge("shop", { environment, stage: "published" })).toHaveLength(2);
    expect(listTools("shop", { environment, stage: "published" })).toHaveLength(2);
    expect(getAgentFor("shop", { environment, stage: "published" })?.instructions).toContain("bundle-first");
  });

  it("supports rollback and environment promotion", () => {
    const sourceEnvironment = "staging";

    upsertRuntimeAgentConfig({
      name: "shop",
      instructions: "Release candidate agent",
    }, { environment: sourceEnvironment });
    publishDraft({ environment: sourceEnvironment, note: "RC1" });

    upsertRuntimeAgentConfig({
      name: "shop",
      instructions: "Release candidate agent v2",
    }, { environment: sourceEnvironment });
    const secondRelease = publishDraft({ environment: sourceEnvironment, note: "RC2" });

    const rolledBack = rollbackConfig({
      environment: sourceEnvironment,
      version: 1,
      note: "Rollback to baseline",
    });

    expect(rolledBack).not.toBeNull();
    expect(rolledBack?.version).toBe(4);
    expect(getAgentFor("shop", { environment: sourceEnvironment, stage: "published" })?.instructions)
      .toBe("Published shopping agent");

    const promoted = promoteConfig({
      sourceEnvironment,
      targetEnvironment: "production",
      releaseId: secondRelease.id,
      publish: true,
      note: "Promote RC2",
    });

    expect(promoted).not.toBeNull();
    expect(promoted?.release?.version).toBe(2);
    expect(getAgentFor("shop", { environment: "production", stage: "published" })?.instructions)
      .toBe("Release candidate agent v2");
    expect(listConfigReleases("production")).toHaveLength(2);
    expect(getConfigSnapshot({ environment: "production", stage: "draft" }).agents[0]?.instructions)
      .toBe("Release candidate agent v2");
  });
});
