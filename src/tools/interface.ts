import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import { Type, type TSchema, type Static } from "@mariozechner/pi-ai";

export { Type } from "@mariozechner/pi-ai";

/**
 * Define a clawless tool. This is the main API for creating tools
 * that the agent can call during its multi-step execution.
 *
 * Uses TypeBox schemas (same as Pi SDK / OpenClaw) for parameter validation.
 *
 * @example
 * ```ts
 * import { defineTool, Type } from "./interface.js";
 *
 * export const myTool = defineTool({
 *   name: "my_tool",
 *   label: "My Tool",
 *   description: "Does something useful",
 *   parameters: Type.Object({
 *     query: Type.String({ description: "Search query" }),
 *   }),
 *   execute: async (params) => {
 *     const result = await fetch(`https://api.example.com?q=${params.query}`);
 *     return JSON.stringify(await result.json());
 *   },
 * });
 * ```
 */
export function defineTool<TParams extends TSchema>(config: {
  name: string;
  label: string;
  description: string;
  parameters: TParams;
  execute: (
    params: Static<TParams>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback
  ) => Promise<string>;
}): AgentTool<TParams> {
  return {
    name: config.name,
    label: config.label,
    description: config.description,
    parameters: config.parameters,
    execute: async (
      toolCallId: string,
      params: Static<TParams>,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback
    ): Promise<AgentToolResult<unknown>> => {
      try {
        const resultText = await config.execute(params, signal, onUpdate);
        return {
          content: [{ type: "text", text: resultText }],
          details: undefined,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  };
}
