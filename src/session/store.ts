import type { AgentMessage } from "@mariozechner/pi-agent-core";

export interface SessionData {
  id: string;
  userId: string;
  toolSet: string;
  messages: AgentMessage[];
  createdAt: number;
  updatedAt: number;
}

/**
 * Pluggable session store interface.
 *
 * All operations are scoped by userId — the agent never sees
 * another user's sessions or conversation history.
 */
export interface SessionStore {
  load(id: string, userId: string): Promise<SessionData | null>;
  save(session: SessionData): Promise<void>;
  delete(id: string, userId: string): Promise<void>;
  list(userId: string): Promise<Array<{ id: string; toolSet: string; updatedAt: number }>>;
}
