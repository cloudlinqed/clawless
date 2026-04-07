import { pathToFileURL } from "node:url";
import path from "node:path";
import type { AgentDef } from "./agent-def.js";
import { registerAgent } from "./agent-def.js";

/**
 * Load agent definitions from clawless.config.ts.
 *
 * The config file exports named AgentDef objects.
 * Each one is registered as an available agent.
 */
export async function loadConfig(configPath?: string): Promise<void> {
  const resolved = configPath ?? path.resolve(process.cwd(), "clawless.config.ts");

  let configModule: Record<string, unknown>;
  try {
    const fileUrl = pathToFileURL(resolved).href;
    configModule = await import(fileUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load config from ${resolved}: ${message}`);
  }

  let count = 0;
  for (const [exportName, value] of Object.entries(configModule)) {
    if (isAgentDef(value)) {
      registerAgent(value);
      count++;
    }
  }

  if (count === 0) {
    throw new Error(
      `No agent definitions found in ${resolved}. ` +
      `Export AgentDef objects using defineAgent().`
    );
  }
}

function isAgentDef(value: unknown): value is AgentDef {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    "instructions" in value &&
    "tools" in value &&
    typeof (value as any).name === "string" &&
    typeof (value as any).instructions === "string" &&
    Array.isArray((value as any).tools)
  );
}
