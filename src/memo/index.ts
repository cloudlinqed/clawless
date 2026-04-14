import type { MemoStore } from "./store.js";
import { MemoryMemoStore } from "./memory.js";

export type { MemoEntry, MemoStore } from "./store.js";
export { MemoryMemoStore } from "./memory.js";

let defaultStore: MemoStore | undefined;

export function getMemoStore(): MemoStore {
  if (!defaultStore) {
    defaultStore = new MemoryMemoStore();
  }
  return defaultStore;
}

export function setMemoStore(store: MemoStore): void {
  defaultStore = store;
}
