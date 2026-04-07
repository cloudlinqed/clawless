import type { SessionData, SessionStore } from "./store.js";

/**
 * In-memory session store for local development and testing.
 * Sessions are lost when the process restarts.
 */
export class MemorySessionStore implements SessionStore {
  private sessions = new Map<string, SessionData>();

  async load(id: string): Promise<SessionData | null> {
    return this.sessions.get(id) ?? null;
  }

  async save(session: SessionData): Promise<void> {
    this.sessions.set(session.id, session);
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async list(): Promise<Array<{ id: string; toolSet: string; updatedAt: number }>> {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      toolSet: s.toolSet,
      updatedAt: s.updatedAt,
    }));
  }
}
