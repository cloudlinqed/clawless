import type { AgentTool } from "@mariozechner/pi-agent-core";
import { fetchPageTool } from "./fetch-page.js";
import { jsonRequestTool } from "./json-request.js";
import { webSearchTool } from "./web-search.js";
import { currentDatetimeTool } from "./current-datetime.js";
import { storeMemoTool, recallMemoTool, setMemoUserId } from "./memo.js";
import { updatePlanTool, setPlanSessionKey } from "./update-plan.js";
import { sessionsListTool, sessionsHistoryTool, setSessionsUserId } from "./sessions.js";
import { sessionsSpawnTool, setSpawnContext } from "./sessions-spawn.js";
import { subagentsTool, setSubagentsSessionKey } from "./subagents.js";
import { imageAnalyzeTool } from "./image-analyze.js";
import { imageGenerateTool } from "./image-generate.js";
import { ttsTool } from "./tts.js";

export { setMemoUserId } from "./memo.js";
export { setPlanSessionKey } from "./update-plan.js";
export { setSessionsUserId } from "./sessions.js";
export { setSpawnContext } from "./sessions-spawn.js";
export { setSubagentsSessionKey } from "./subagents.js";

/**
 * All available built-in tools and their default enabled state.
 *
 * Tools that need external API keys are disabled by default —
 * the frontend enables them via /api/builtins/:name/enable after
 * providing the required secrets.
 */
const BUILTIN_CATALOG: Record<string, { tool: AgentTool<any, any>; defaultEnabled: boolean }> = {
  // Core (always on)
  fetch_page:        { tool: fetchPageTool,        defaultEnabled: true },
  json_request:      { tool: jsonRequestTool,       defaultEnabled: true },
  current_datetime:  { tool: currentDatetimeTool,   defaultEnabled: true },
  store_memo:        { tool: storeMemoTool,         defaultEnabled: true },
  recall_memo:       { tool: recallMemoTool,        defaultEnabled: true },
  update_plan:       { tool: updatePlanTool,        defaultEnabled: true },
  sessions_list:     { tool: sessionsListTool,      defaultEnabled: true },
  sessions_history:  { tool: sessionsHistoryTool,   defaultEnabled: true },

  // Multi-agent
  sessions_spawn:    { tool: sessionsSpawnTool,     defaultEnabled: true },
  subagents:         { tool: subagentsTool,         defaultEnabled: true },

  // Needs API key (disabled by default)
  web_search:        { tool: webSearchTool,         defaultEnabled: false },
  image_analyze:     { tool: imageAnalyzeTool,      defaultEnabled: false },
  image_generate:    { tool: imageGenerateTool,     defaultEnabled: false },
  text_to_speech:    { tool: ttsTool,               defaultEnabled: false },
};

// Tracks which builtins are enabled (overrides defaults)
const enabledOverrides = new Map<string, boolean>();

export function enableBuiltin(name: string): boolean {
  if (!(name in BUILTIN_CATALOG)) return false;
  enabledOverrides.set(name, true);
  return true;
}

export function disableBuiltin(name: string): boolean {
  if (!(name in BUILTIN_CATALOG)) return false;
  enabledOverrides.set(name, false);
  return true;
}

export function listBuiltins(): Array<{ name: string; enabled: boolean; description: string }> {
  return Object.entries(BUILTIN_CATALOG).map(([name, { tool, defaultEnabled }]) => ({
    name,
    enabled: enabledOverrides.get(name) ?? defaultEnabled,
    description: tool.description,
  }));
}

/**
 * Get all enabled built-in tools. Called at agent runtime.
 * Sets the userId/sessionKey context for user-scoped tools.
 */
export function getEnabledBuiltins(context: { userId: string; sessionKey: string }): AgentTool<any, any>[] {
  setMemoUserId(context.userId);
  setPlanSessionKey(context.sessionKey);
  setSessionsUserId(context.userId);
  setSpawnContext(context.sessionKey, context.userId);
  setSubagentsSessionKey(context.sessionKey);

  const tools: AgentTool<any, any>[] = [];
  for (const [name, { tool, defaultEnabled }] of Object.entries(BUILTIN_CATALOG)) {
    const enabled = enabledOverrides.get(name) ?? defaultEnabled;
    if (enabled) tools.push(tool);
  }
  return tools;
}
