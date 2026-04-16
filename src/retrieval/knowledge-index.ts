import type { AgentDef, AgentRetrievalSourceKnowledge } from "../config/agent-def.js";
import { listKnowledge, type KnowledgeItem } from "../config/knowledge.js";
import type { RetrievedDocument } from "./registry.js";

const DEFAULT_CHUNK_SIZE = 1200;
const DEFAULT_CHUNK_OVERLAP = 200;
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how",
  "i", "in", "is", "it", "of", "on", "or", "that", "the", "this", "to",
  "was", "what", "when", "where", "which", "who", "why", "with", "you",
]);

interface KnowledgeChunk {
  id: string;
  title: string;
  content: string;
  tokens: string[];
  tokenSet: Set<string>;
  priority: number;
  url?: string;
}

export function retrieveFromKnowledgeIndex(
  query: string,
  agentDef: AgentDef,
  source: AgentRetrievalSourceKnowledge,
  defaults: { topK: number; maxChars: number }
): RetrievedDocument[] {
  const knowledge = listKnowledge(agentDef.name);
  if (knowledge.length === 0) {
    return [];
  }

  const chunks = knowledge.flatMap((item) => chunkKnowledgeItem(item, source));
  if (chunks.length === 0) {
    return [];
  }

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return [];
  }

  const docFrequency = new Map<string, number>();
  for (const token of new Set(queryTokens)) {
    let count = 0;
    for (const chunk of chunks) {
      if (chunk.tokenSet.has(token)) count++;
    }
    docFrequency.set(token, count);
  }

  const scored = chunks
    .map((chunk) => ({
      chunk,
      score: scoreChunk(query, queryTokens, chunk, docFrequency, chunks.length),
    }))
    .filter((entry) => entry.score >= (source.minScore ?? 0.35))
    .sort((a, b) => b.score - a.score);

  const topK = source.topK ?? defaults.topK;
  const maxChars = source.maxChars ?? defaults.maxChars;
  const documents: RetrievedDocument[] = [];
  let usedChars = 0;

  for (const entry of scored) {
    if (documents.length >= topK) break;
    const remaining = maxChars - usedChars;
    if (remaining <= 120) break;

    const content = trimToLength(entry.chunk.content, remaining);
    if (!content) continue;

    documents.push({
      id: entry.chunk.id,
      title: entry.chunk.title,
      content,
      score: roundScore(entry.score),
      sourceType: "knowledge",
      sourceName: "knowledge_index",
      url: entry.chunk.url,
      metadata: {
        priority: entry.chunk.priority,
      },
    });

    usedChars += content.length;
  }

  return documents;
}

function chunkKnowledgeItem(item: KnowledgeItem, source: AgentRetrievalSourceKnowledge): KnowledgeChunk[] {
  const chunkSize = source.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunkOverlap = Math.min(source.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP, Math.floor(chunkSize / 2));
  const paragraphs = item.content
    .split(/\n\s*\n/g)
    .map((part) => part.trim())
    .filter(Boolean);
  const segments = paragraphs.length > 0 ? paragraphs : [item.content.trim()];
  const chunks: KnowledgeChunk[] = [];

  let current = "";
  let index = 0;

  for (const segment of segments) {
    const candidate = current ? `${current}\n\n${segment}` : segment;
    if (candidate.length <= chunkSize) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(makeChunk(item, current, index++));
    }

    if (segment.length <= chunkSize) {
      current = segment;
      continue;
    }

    const slices = sliceText(segment, chunkSize, chunkOverlap);
    for (const slice of slices) {
      chunks.push(makeChunk(item, slice, index++));
    }
    current = "";
  }

  if (current) {
    chunks.push(makeChunk(item, current, index++));
  }

  return chunks;
}

function makeChunk(item: KnowledgeItem, content: string, index: number): KnowledgeChunk {
  const title = index === 0 ? item.title : `${item.title} (part ${index + 1})`;
  const tokens = tokenize(`${item.title}\n${content}`);
  return {
    id: `${item.id}#${index}`,
    title,
    content,
    tokens,
    tokenSet: new Set(tokens),
    priority: item.priority,
    url: extractFirstUrl(content),
  };
}

function sliceText(text: string, chunkSize: number, overlap: number): string[] {
  const parts: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(text.length, start + chunkSize);
    parts.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }

  return parts.filter(Boolean);
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [])
    .filter((token) => !STOP_WORDS.has(token));
}

function scoreChunk(
  query: string,
  queryTokens: string[],
  chunk: KnowledgeChunk,
  docFrequency: Map<string, number>,
  totalChunks: number
): number {
  const frequencies = new Map<string, number>();
  for (const token of chunk.tokens) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }

  let score = 0;
  let matchedTerms = 0;

  for (const token of new Set(queryTokens)) {
    const frequency = frequencies.get(token) ?? 0;
    if (frequency <= 0) continue;
    matchedTerms++;
    const df = docFrequency.get(token) ?? 1;
    const idf = Math.log(1 + totalChunks / (1 + df));
    score += (1 + Math.log(1 + frequency)) * idf;
    if (chunk.title.toLowerCase().includes(token)) {
      score += 0.5;
    }
  }

  if (matchedTerms === 0) {
    return 0;
  }

  const coverageBoost = matchedTerms / new Set(queryTokens).size;
  const phraseBoost = chunk.content.toLowerCase().includes(query.toLowerCase()) ? 1.5 : 0;
  const priorityBoost = 1 + Math.max(0, 200 - chunk.priority) / 400;
  const lengthPenalty = Math.pow(Math.max(chunk.tokens.length, 40), 0.22);

  return ((score / lengthPenalty) + coverageBoost + phraseBoost) * priorityBoost;
}

function extractFirstUrl(text: string): string | undefined {
  const match = text.match(/https?:\/\/[^\s)]+/i);
  return match?.[0];
}

function trimToLength(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}
