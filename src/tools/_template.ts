/**
 * Template for creating a new clawless tool.
 *
 * Copy this file and rename it to your tool name.
 * Tools are self-contained async functions the agent can call.
 *
 * The agent decides WHEN and HOW to call your tool based on
 * the name, description, and parameter descriptions you provide.
 * Write clear descriptions — they're the agent's only documentation.
 */

import { defineTool, Type } from "./interface.js";

export const myTool = defineTool({
  name: "my_tool",
  label: "My Tool",
  description: "Describe what this tool does clearly — the agent reads this to decide when to use it",
  parameters: Type.Object({
    query: Type.String({ description: "What this parameter means" }),
    limit: Type.Optional(Type.Number({ description: "Max results to return", default: 10 })),
  }),
  execute: async (params, signal) => {
    // Your implementation here.
    // Return a JSON string — the agent will parse and reason about it.
    const result = { query: params.query, data: [] };
    return JSON.stringify(result);
  },
});
