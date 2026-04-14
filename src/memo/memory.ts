import type { MemoEntry, MemoStore } from "./store.js";

export class MemoryMemoStore implements MemoStore {
  private memos = new Map<string, Map<string, MemoEntry>>();

  private getUserMemos(userId: string): Map<string, MemoEntry> {
    let entries = this.memos.get(userId);
    if (!entries) {
      entries = new Map();
      this.memos.set(userId, entries);
    }
    return entries;
  }

  async getMemo(userId: string, key: string): Promise<MemoEntry | null> {
    return this.getUserMemos(userId).get(key) ?? null;
  }

  async setMemo(userId: string, key: string, content: string): Promise<MemoEntry> {
    const entries = this.getUserMemos(userId);
    const now = Date.now();
    const existing = entries.get(key);
    const entry: MemoEntry = {
      userId,
      key,
      content,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    entries.set(key, entry);
    return entry;
  }

  async deleteMemo(userId: string, key: string): Promise<void> {
    this.getUserMemos(userId).delete(key);
  }

  async listMemos(userId: string): Promise<MemoEntry[]> {
    return Array.from(this.getUserMemos(userId).values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
