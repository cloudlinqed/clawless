import { z } from "zod";
import { httpTool, type HttpToolConfig } from "../tools/http-tool.js";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
  getConfigSnapshot,
  isConfigLifecycleEnabled,
  mutateDraftSnapshot,
  type ConfigStage,
} from "./lifecycle.js";

// ── Schema ──

const HttpParamSchema = z.object({
  type: z.enum(["string", "number", "boolean"]),
  description: z.string().min(1),
  required: z.boolean().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

export const HttpToolConfigSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z0-9_]+$/, "Tool name must be lowercase alphanumeric with underscores"),
  label: z.string().max(100).optional(),
  description: z.string().min(1).max(2000),
  method: z.enum(["GET", "POST", "PUT", "DELETE"]).optional(),
  url: z.string().url(),
  parameters: z.record(HttpParamSchema),
  auth: z.object({
    queryParams: z.record(z.string()).optional(),
    headers: z.record(z.string()).optional(),
  }).optional(),
  paramLocation: z.enum(["query", "body"]).optional(),
});

export type StoredToolConfig = z.infer<typeof HttpToolConfigSchema> & {
  agent: string;
  createdAt: number;
  updatedAt: number;
};

// ── Persistence interface ──

export interface ToolPersistence {
  loadTools(): Promise<StoredToolConfig[]>;
  saveTools(tools: StoredToolConfig[]): Promise<void>;
}

// ── Store ──

const toolConfigs = new Map<string, StoredToolConfig>();
let persistence: ToolPersistence | null = null;

export function setToolPersistence(p: ToolPersistence): void {
  persistence = p;
}

export async function loadToolsFromPersistence(): Promise<void> {
  if (!persistence) return;
  const items = await persistence.loadTools();
  for (const item of items) {
    toolConfigs.set(item.name, item);
  }
}

async function persist(): Promise<void> {
  if (!persistence) return;
  await persistence.saveTools(Array.from(toolConfigs.values()));
}

// ── CRUD ──

export function registerTool(
  input: z.infer<typeof HttpToolConfigSchema>,
  agent: string,
  options?: { environment?: string }
): { ok: true; tool: StoredToolConfig } | { ok: false; error: string } {
  const parsed = HttpToolConfigSchema.safeParse(input);
  if (!parsed.success) {
    const errors = parsed.error.flatten();
    return { ok: false, error: JSON.stringify(errors.fieldErrors) };
  }

  const now = Date.now();
  const existing = getTool(parsed.data.name, { environment: options?.environment, stage: "draft" });
  const stored: StoredToolConfig = {
    ...parsed.data,
    agent,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  if (isConfigLifecycleEnabled()) {
    mutateDraftSnapshot(options?.environment, (snapshot) => {
      snapshot.tools = snapshot.tools
        .filter((tool) => tool.name !== stored.name)
        .concat(stored)
        .sort((a, b) => a.name.localeCompare(b.name));
    });
  } else {
    toolConfigs.set(stored.name, stored);
    persist();
  }
  return { ok: true, tool: stored };
}

export function updateTool(
  name: string,
  updates: Partial<z.infer<typeof HttpToolConfigSchema>>,
  options?: { environment?: string }
): StoredToolConfig | null {
  const existing = getTool(name, { environment: options?.environment, stage: "draft" });
  if (!existing) return null;

  const parsed = HttpToolConfigSchema.safeParse({ ...existing, ...updates });
  if (!parsed.success) return null;

  const merged = {
    ...existing,
    ...parsed.data,
    agent: existing.agent,
    createdAt: existing.createdAt,
    updatedAt: Date.now(),
  };

  if (isConfigLifecycleEnabled()) {
    mutateDraftSnapshot(options?.environment, (snapshot) => {
      snapshot.tools = snapshot.tools
        .filter((tool) => tool.name !== name)
        .concat(merged)
        .sort((a, b) => a.name.localeCompare(b.name));
    });
  } else {
    toolConfigs.set(name, merged);
    persist();
  }
  return merged;
}

export function deleteTool(name: string, options?: { environment?: string }): boolean {
  if (isConfigLifecycleEnabled()) {
    return mutateDraftSnapshot(options?.environment, (snapshot) => {
      const before = snapshot.tools.length;
      snapshot.tools = snapshot.tools.filter((tool) => tool.name !== name);
      return snapshot.tools.length !== before;
    });
  }

  const deleted = toolConfigs.delete(name);
  if (deleted) persist();
  return deleted;
}

export function getTool(
  name: string,
  options?: { environment?: string; stage?: ConfigStage }
): StoredToolConfig | null {
  return listTools(undefined, options).find((tool) => tool.name === name) ?? null;
}

export function listTools(
  agent?: string,
  options?: { environment?: string; stage?: ConfigStage }
): StoredToolConfig[] {
  const all = isConfigLifecycleEnabled()
    ? getConfigSnapshot({
        environment: options?.environment,
        stage: options?.stage,
      }).tools
    : Array.from(toolConfigs.values());
  if (agent) return all.filter((t) => t.agent === agent);
  return all;
}

/**
 * Build callable AgentTool instances from stored configs.
 * Called at agent runtime to merge with static config tools.
 */
export function buildDynamicTools(agent?: string): AgentTool<any, any>[] {
  const configs = listTools(agent);
  return configs.map((config) => httpTool(config) as AgentTool<any, any>);
}

export function exportBaseToolSnapshot(): StoredToolConfig[] {
  return Array.from(toolConfigs.values()).map((tool) => ({ ...tool }));
}
