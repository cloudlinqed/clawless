import type { AgentDef } from "../config/agent-def.js";

export interface RetrievedDocument {
  id: string;
  title: string;
  content: string;
  score: number;
  sourceType: "knowledge" | "retriever";
  sourceName: string;
  url?: string;
  metadata?: Record<string, unknown>;
}

export interface RetrieverRequest {
  query: string;
  agent: AgentDef;
  topK: number;
  maxChars: number;
  signal?: AbortSignal;
}

export interface Retriever {
  name: string;
  description?: string;
  retrieve(request: RetrieverRequest): Promise<RetrievedDocument[]>;
}

const retrievers = new Map<string, Retriever>();

export function registerRetriever(retriever: Retriever): void {
  retrievers.set(retriever.name, retriever);
}

export function getRetriever(name: string): Retriever | undefined {
  return retrievers.get(name);
}

export function listRetrievers(): Array<{ name: string; description?: string }> {
  return Array.from(retrievers.values())
    .map((retriever) => ({
      name: retriever.name,
      description: retriever.description,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
