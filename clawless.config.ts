/**
 * Clawless agent configuration.
 *
 * This is where you define what your agent does.
 * Write instructions in natural language, give it tools,
 * and the agent figures out the rest — just like OpenClaw.
 *
 * You can define multiple agents. Each one is reachable via
 * its name in the API: POST /api/agent { agent: "my-agent", prompt: "..." }
 */

import { defineAgent } from "./src/config/agent-def.js";
// import { httpTool } from "./src/tools/http-tool.js";
// import { defineTool, Type } from "./src/tools/interface.js";

export const assistant = defineAgent({
  name: "assistant",

  instructions: `You are a helpful AI assistant. Answer questions clearly and concisely.

When tools are available, use them to accomplish the user's request.
Think step by step about which tools to call and in what order.`,

  tools: [
    // Add your tools here. Examples:
    //
    // httpTool({
    //   name: "search_api",
    //   description: "Search for items via an external API",
    //   url: "https://api.example.com/search",
    //   parameters: {
    //     query: { type: "string", description: "Search query", required: true },
    //   },
    //   auth: {
    //     queryParams: { api_key: "MY_API_KEY" },
    //   },
    // }),
  ],
});
