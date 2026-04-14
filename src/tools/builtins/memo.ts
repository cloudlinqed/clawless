import { defineTool, Type } from "../interface.js";
import { getMemoStore } from "../../memo/index.js";
import { requireRequestContext } from "../../runtime/request-context.js";

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
    const { userId } = requireRequestContext();
    const memos = getMemoStore();
    const saved = await memos.setMemo(userId, params.key, params.content);
    const all = await memos.listMemos(userId);
    return JSON.stringify({ ok: true, key: saved.key, totalMemos: all.length });
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
    const { userId } = requireRequestContext();
    const memos = getMemoStore();

    if (params.key) {
      const memo = await memos.getMemo(userId, params.key);
      if (!memo) {
        const available = await memos.listMemos(userId);
        return JSON.stringify({ found: false, key: params.key, availableKeys: available.map((entry) => entry.key) });
      }
      return JSON.stringify({ found: true, key: params.key, content: memo.content });
    }

    const memoEntries = await memos.listMemos(userId);
    const entries: Record<string, string> = {};
    for (const memo of memoEntries) {
      entries[memo.key] = memo.content.length > 200 ? memo.content.slice(0, 200) + "..." : memo.content;
    }
    return JSON.stringify({ totalMemos: Object.keys(entries).length, memos: entries });
  },
});
