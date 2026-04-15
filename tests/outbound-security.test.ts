import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineAgent } from "../src/config/agent-def.js";
import { addKnowledge, deleteKnowledge, deleteSecret, setSecret } from "../src/config/knowledge.js";
import { registerTool, deleteTool } from "../src/config/tool-store.js";
import { matchesHostPattern, collectContextualAllowedHosts } from "../src/security/outbound.js";
import { resolveSecretValue } from "../src/tools/builtins/resolve-secrets.js";
import { httpTool } from "../src/tools/http-tool.js";

const ENV_KEYS = [
  "OUTBOUND_ALLOWED_HOSTS",
  "OPENAI_API_KEY",
  "CLAWLESS_SECRET_STORE_API_KEY",
];

const envSnapshot = new Map<string, string | undefined>();

beforeEach(() => {
  envSnapshot.clear();
  for (const key of ENV_KEYS) {
    envSnapshot.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  deleteKnowledge("net-test-knowledge");
  deleteTool("inventory_lookup");
  deleteSecret("STORE_API_KEY");

  for (const key of ENV_KEYS) {
    const value = envSnapshot.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("outbound security defaults", () => {
  it("derives builtin outbound hosts from tools, knowledge URLs, and explicit allowlists", () => {
    process.env.OUTBOUND_ALLOWED_HOSTS = "*.global.example.com";

    addKnowledge({
      id: "net-test-knowledge",
      agent: "net-test",
      title: "Store API Docs",
      content: "Primary docs: https://docs.example.com/guide and CDN https://cdn.example.com/manual.pdf",
      priority: 10,
    });

    registerTool({
      name: "inventory_lookup",
      description: "Inventory lookup",
      url: "https://inventory.example.com/search",
      parameters: {},
    }, "net-test");

    const agent = defineAgent({
      name: "net-test",
      instructions: "You help users shop for products in this store.",
      tools: [
        httpTool({
          name: "search_catalog",
          description: "Search the product catalog",
          url: "https://api.example.com/search",
          parameters: {
            query: { type: "string", description: "Search query", required: true },
          },
        }),
      ],
    });

    expect(new Set(collectContextualAllowedHosts(agent))).toEqual(new Set([
      "*.global.example.com",
      "api.example.com",
      "inventory.example.com",
      "docs.example.com",
      "cdn.example.com",
    ]));
  });

  it("matches exact and wildcard host patterns", () => {
    expect(matchesHostPattern("api.example.com", "api.example.com")).toBe(true);
    expect(matchesHostPattern("docs.example.com", "*.example.com")).toBe(true);
    expect(matchesHostPattern("example.com", "*.example.com")).toBe(true);
    expect(matchesHostPattern("evil-example.com", "*.example.com")).toBe(false);
  });

  it("resolves only registered or prefixed secrets, not arbitrary env vars", () => {
    process.env.OPENAI_API_KEY = "model-key";
    process.env.CLAWLESS_SECRET_STORE_API_KEY = "prefixed-key";
    setSecret("STORE_API_KEY", "registered-key");

    expect(resolveSecretValue("STORE_API_KEY")).toBe("registered-key");
    expect(resolveSecretValue("OPENAI_API_KEY")).toBe("OPENAI_API_KEY");
    deleteSecret("STORE_API_KEY");
    expect(resolveSecretValue("STORE_API_KEY")).toBe("prefixed-key");
  });
});
