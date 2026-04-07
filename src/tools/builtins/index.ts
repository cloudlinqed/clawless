import type { AgentTool } from "@mariozechner/pi-agent-core";
import { fetchPageTool } from "./fetch-page.js";
import { jsonRequestTool } from "./json-request.js";
import { webSearchTool } from "./web-search.js";
import { currentDatetimeTool } from "./current-datetime.js";
import { storeMemoTool, recallMemoTool, setMemoUserId } from "./memo.js";
import { updatePlanTool, setPlanSessionKey } from "./update-plan.js";
import { sessionsListTool, sessionsHistoryTool, setSessionsUserId } from "./sessions.js";

export { setMemoUserId } from "./memo.js";
export { setPlanSessionKey } from "./update-plan.js";
export { setSessionsUserId } from "./sessions.js";

/**
 * All available built-in tools and their default enabled state.
 */
const BUILTIN_CATALOG: Record<string, { tool: AgentTool<any, any>; defaultEnabled: boolean }> = {
  fetch_page:       { tool: fetchPageTool,       defaultEnabled: true },
  json_request:     { tool: jsonRequestTool,      defaultEnabled: true },
  web_search:       { tool: webSearchTool,        defaultEnabled: false }, // needs API key
  current_datetime: { tool: currentDatetimeTool,  defaultEnabled: true },
  store_memo:       { tool: storeMemoTool,        defaultEnabled: true },
  recall_memo:      { tool: recallMemoTool,       defaultEnabled: true },
  update_plan:      { tool: updatePlanTool,       defaultEnabled: true },
  sessions_list:    { tool: sessionsListTool,     defaultEnabled: true },
  sessions_history: { tool: sessionsHistoryTool,  defaultEnabled: true },
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
 * Also sets the userId/sessionKey context for user-scoped tools.
 */
export function getEnabledBuiltins(context: { userId: string; sessionKey: string }): AgentTool<any, any>[] {
  // Set user context for scoped tools
  setMemoUserId(context.userId);
  setPlanSessionKey(context.sessionKey);
  setSessionsUserId(context.userId);

  const tools: AgentTool<any, any>[] = [];
  for (const [name, { tool, defaultEnabled }] of Object.entries(BUILTIN_CATALOG)) {
    const enabled = enabledOverrides.get(name) ?? defaultEnabled;
    if (enabled) tools.push(tool);
  }
  return tools;
}
