import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import type { AgentDef } from "./agent-def.js";
import { registerAgent } from "./agent-def.js";

/**
 * Load agent definitions from clawless.config.
 *
 * Looks for (in order):
 * 1. dist/clawless.config.js  (compiled — production on Railway/Vercel)
 * 2. clawless.config.js       (compiled — if rootDir is ".")
 * 3. clawless.config.ts       (source — dev with tsx)
 */
export async function loadConfig(configPath?: string): Promise<void> {
  const cwd = process.cwd();
  const resolved = configPath ?? findConfig(cwd);

  if (!resolved) {
    throw new Error(
      `No clawless config found in ${cwd}. ` +
      `Create clawless.config.ts with defineAgent() exports.`
    );
  }

  let configModule: Record<string, unknown>;
  try {
    const fileUrl = pathToFileURL(resolved).href;
    configModule = await import(fileUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load config from ${resolved}: ${message}`);
  }

  let count = 0;
  for (const [, value] of Object.entries(configModule)) {
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

function findConfig(cwd: string): string | null {
  const candidates = [
    path.resolve(cwd, "dist", "clawless.config.js"),
    path.resolve(cwd, "clawless.config.js"),
    path.resolve(cwd, "clawless.config.ts"),
  ];
  for (const full of candidates) {
    if (fs.existsSync(full)) return full;
  }
  return null;
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
