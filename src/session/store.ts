import type { AgentMessage } from "@mariozechner/pi-agent-core";

export interface SessionData {
  id: string;
  toolSet: string;
  messages: AgentMessage[];
  createdAt: number;
  updatedAt: number;
}

/**
 * Pluggable session store interface.
 *
 * Implementations can be backed by in-memory maps, Vercel KV,
 * Upstash Redis, DynamoDB, or any other storage backend.
 * The backend is chosen at deploy time via SESSION_STORE env var.
 */
export interface SessionStore {
  load(id: string): Promise<SessionData | null>;
  save(session: SessionData): Promise<void>;
  delete(id: string): Promise<void>;
  list(): Promise<Array<{ id: string; toolSet: string; updatedAt: number }>>;
}
