import type { SessionData, SessionStore } from "./store.js";

/**
 * In-memory session store for local development and testing.
 * Sessions are user-scoped — each user only sees their own data.
 */
export class MemorySessionStore implements SessionStore {
  private sessions = new Map<string, SessionData>();

  async load(id: string, userId: string): Promise<SessionData | null> {
    const session = this.sessions.get(id);
    if (!session || session.userId !== userId) return null;
    return session;
  }

  async save(session: SessionData): Promise<void> {
    this.sessions.set(session.id, session);
  }

  async delete(id: string, userId: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session && session.userId === userId) {
      this.sessions.delete(id);
    }
  }

  async list(userId: string): Promise<Array<{ id: string; toolSet: string; updatedAt: number }>> {
    return Array.from(this.sessions.values())
      .filter((s) => s.userId === userId)
      .map((s) => ({
        id: s.id,
        toolSet: s.toolSet,
        updatedAt: s.updatedAt,
      }));
  }
}
