import type { SessionStore } from "./store.js";
import { MemorySessionStore } from "./memory.js";

export type { SessionData, SessionStore } from "./store.js";
export { MemorySessionStore } from "./memory.js";

let defaultStore: SessionStore | undefined;

/**
 * Get the session store based on SESSION_STORE env var.
 * Defaults to in-memory if not configured.
 */
export function getSessionStore(): SessionStore {
  if (defaultStore) return defaultStore;

  const storeType = process.env.SESSION_STORE ?? "memory";

  switch (storeType) {
    case "memory":
      defaultStore = new MemorySessionStore();
      break;
    // Future adapters:
    // case "upstash":
    //   defaultStore = new UpstashSessionStore();
    //   break;
    // case "vercel-kv":
    //   defaultStore = new VercelKVSessionStore();
    //   break;
    default:
      defaultStore = new MemorySessionStore();
  }

  return defaultStore;
}

export function setSessionStore(store: SessionStore): void {
  defaultStore = store;
}
