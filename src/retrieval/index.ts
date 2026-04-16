import type {
  AgentDef,
  AgentRetrievalConfig,
  AgentRetrievalSource,
  AgentRetrievalSourceKnowledge,
  AgentRetrievalSourceRetriever,
} from "../config/agent-def.js";
import { retrieveFromKnowledgeIndex } from "./knowledge-index.js";
import { getRetriever, type RetrievedDocument } from "./registry.js";

const DEFAULT_TOP_K = 6;
const DEFAULT_MAX_CHARS = 6000;

export async function retrieveAgentContext(
  query: string,
  agentDef: AgentDef,
  signal?: AbortSignal
): Promise<RetrievedDocument[]> {
  const retrieval = agentDef.retrieval;
  if (!retrieval || getRetrievalMode(retrieval) === "off") {
    return [];
  }

  const defaults = {
    topK: retrieval.topK ?? DEFAULT_TOP_K,
    maxChars: retrieval.maxChars ?? DEFAULT_MAX_CHARS,
  };
  const sources = normalizeSources(retrieval);

  const results = await Promise.all(
    sources.map(async (source) => {
      switch (source.type) {
        case "knowledge":
          return retrieveFromKnowledgeIndex(query, agentDef, source, defaults);
        case "retriever":
          return retrieveFromCustomRetriever(query, agentDef, source, defaults, signal);
      }
    })
  );

  return dedupeDocuments(results.flat(), defaults.topK, defaults.maxChars);
}

export function getRetrievalMode(config?: AgentRetrievalConfig): "off" | "indexed" | "hybrid" {
  return config?.mode ?? "off";
}

export function shouldInjectStaticKnowledge(agentDef: Pick<AgentDef, "retrieval">): boolean {
  const mode = getRetrievalMode(agentDef.retrieval);
  return mode === "off" || mode === "hybrid";
}

function normalizeSources(config: AgentRetrievalConfig): AgentRetrievalSource[] {
  if (config.sources && config.sources.length > 0) {
    return config.sources;
  }
  return [{ type: "knowledge" }];
}

async function retrieveFromCustomRetriever(
  query: string,
  agentDef: AgentDef,
  source: AgentRetrievalSourceRetriever,
  defaults: { topK: number; maxChars: number },
  signal?: AbortSignal
): Promise<RetrievedDocument[]> {
  const retriever = getRetriever(source.name);
  if (!retriever) {
    return [];
  }

  try {
    const results = await retriever.retrieve({
      query,
      agent: agentDef,
      topK: source.topK ?? defaults.topK,
      maxChars: source.maxChars ?? defaults.maxChars,
      signal,
    });

    return results
      .filter((doc) => doc.score >= (source.minScore ?? 0))
      .map((doc) => ({
        ...doc,
        sourceType: "retriever",
        sourceName: source.name,
      }));
  } catch {
    return [];
  }
}

function dedupeDocuments(
  documents: RetrievedDocument[],
  maxDocs: number,
  maxChars: number
): RetrievedDocument[] {
  const seen = new Set<string>();
  const unique = documents
    .sort((a, b) => b.score - a.score)
    .filter((doc) => {
      const key = `${doc.sourceName}:${doc.title}:${doc.url ?? ""}:${doc.content.slice(0, 120)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const output: RetrievedDocument[] = [];
  let usedChars = 0;

  for (const doc of unique) {
    if (output.length >= maxDocs) break;
    const remaining = maxChars - usedChars;
    if (remaining <= 120) break;

    const content = trimToLength(doc.content, remaining);
    if (!content) continue;
    output.push({ ...doc, content });
    usedChars += content.length;
  }

  return output;
}

function trimToLength(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}
