import { defineTool, Type } from "../interface.js";

/**
 * Per-user memo store. Agents use this to persist notes across turns
 * and sessions. Scoped by userId so users don't see each other's memos.
 */
const memoStore = new Map<string, Map<string, string>>();

function getUserMemos(userId: string): Map<string, string> {
  let memos = memoStore.get(userId);
  if (!memos) {
    memos = new Map();
    memoStore.set(userId, memos);
  }
  return memos;
}

// userId is injected at runtime by the handler before tool execution
let currentUserId = "default";

export function setMemoUserId(userId: string): void {
  currentUserId = userId;
}

export const storeMemoTool = defineTool({
  name: "store_memo",
  label: "Store Memo",
  description:
    "Save a note for later recall. Use this to remember important information " +
    "across conversation turns — user preferences, intermediate results, " +
    "research findings, or anything the user might ask about later. " +
    "Each memo has a key (short label) and content (the information).",
  parameters: Type.Object({
    key: Type.String({ description: "Short label for this memo (e.g. 'user_budget', 'search_results')" }),
    content: Type.String({ description: "The information to remember" }),
  }),
  execute: async (params) => {
    const memos = getUserMemos(currentUserId);
    memos.set(params.key, params.content);
    return JSON.stringify({ ok: true, key: params.key, totalMemos: memos.size });
  },
});

export const recallMemoTool = defineTool({
  name: "recall_memo",
  label: "Recall Memo",
  description:
    "Retrieve a previously stored memo by its key, or list all stored memos. " +
    "Use this to recall information saved earlier in the conversation or in previous sessions.",
  parameters: Type.Object({
    key: Type.Optional(Type.String({ description: "The memo key to recall. Omit to list all keys." })),
  }),
  execute: async (params) => {
    const memos = getUserMemos(currentUserId);

    if (params.key) {
      const content = memos.get(params.key);
      if (!content) {
        return JSON.stringify({ found: false, key: params.key, availableKeys: Array.from(memos.keys()) });
      }
      return JSON.stringify({ found: true, key: params.key, content });
    }

    // List all
    const entries: Record<string, string> = {};
    for (const [k, v] of memos) {
      entries[k] = v.length > 200 ? v.slice(0, 200) + "..." : v;
    }
    return JSON.stringify({ totalMemos: memos.size, memos: entries });
  },
});
