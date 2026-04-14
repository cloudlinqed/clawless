export interface MemoEntry {
  userId: string;
  key: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface MemoStore {
  getMemo(userId: string, key: string): Promise<MemoEntry | null>;
  setMemo(userId: string, key: string, content: string): Promise<MemoEntry>;
  deleteMemo(userId: string, key: string): Promise<void>;
  listMemos(userId: string): Promise<MemoEntry[]>;
}
