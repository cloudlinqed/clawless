import { z } from "zod";

// ── Schemas ──

export const KnowledgeItemSchema = z.object({
  id: z.string().min(1),
  agent: z.string().min(1),
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(50_000),
  priority: z.number().int().min(0).max(1000).default(100),
});

export const KnowledgeCreateSchema = KnowledgeItemSchema.omit({ id: true }).extend({
  id: z.string().min(1).optional(),
});

export const SecretSchema = z.object({
  key: z.string().min(1).max(100).regex(/^[A-Z0-9_]+$/, "Key must be UPPER_SNAKE_CASE"),
  value: z.string().min(1),
  expiresAt: z.number().int().optional(),
});

export const BulkSetupSchema = z.object({
  knowledge: z.array(KnowledgeCreateSchema).max(50).optional(),
  secrets: z.array(SecretSchema).max(50).optional(),
});

// ── Types ──

export interface KnowledgeItem {
  id: string;
  agent: string;
  title: string;
  content: string;
  priority: number;
  createdAt: number;
  updatedAt: number;
}

export interface SecretEntry {
  key: string;
  value: string;
  expiresAt?: number;
}

// ── Config ──

const MAX_TOTAL_KNOWLEDGE_CHARS = Number(process.env.MAX_KNOWLEDGE_CHARS) || 100_000;

// ── Storage interface ──

export interface KnowledgePersistence {
  loadKnowledge(): Promise<KnowledgeItem[]>;
  saveKnowledge(items: KnowledgeItem[]): Promise<void>;
  loadSecrets(): Promise<SecretEntry[]>;
  saveSecrets(entries: SecretEntry[]): Promise<void>;
}

// In-memory stores
const knowledgeStore = new Map<string, KnowledgeItem>();
const secretsStore = new Map<string, SecretEntry>();
let persistence: KnowledgePersistence | null = null;

// ── Persistence ──

export function setPersistence(p: KnowledgePersistence): void {
  persistence = p;
}

export async function loadFromPersistence(): Promise<void> {
  if (!persistence) return;
  const [items, secrets] = await Promise.all([
    persistence.loadKnowledge(),
    persistence.loadSecrets(),
  ]);
  for (const item of items) knowledgeStore.set(item.id, item);
  for (const entry of secrets) {
    secretsStore.set(entry.key, entry);
    process.env[entry.key] = entry.value;
  }
}

async function persist(): Promise<void> {
  if (!persistence) return;
  await Promise.all([
    persistence.saveKnowledge(Array.from(knowledgeStore.values())),
    persistence.saveSecrets(Array.from(secretsStore.values())),
  ]);
}

// ── Knowledge CRUD ──

function totalKnowledgeChars(exclude?: string): number {
  let total = 0;
  for (const [id, item] of knowledgeStore) {
    if (id !== exclude) total += item.content.length;
  }
  return total;
}

export function addKnowledge(
  input: z.infer<typeof KnowledgeCreateSchema>
): { ok: true; item: KnowledgeItem } | { ok: false; error: string } {
  const parsed = KnowledgeCreateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.flatten().fieldErrors.toString() };
  }

  const data = parsed.data;
  const id = data.id ?? crypto.randomUUID();

  // Size guard
  const currentChars = totalKnowledgeChars(id);
  if (currentChars + data.content.length > MAX_TOTAL_KNOWLEDGE_CHARS) {
    return {
      ok: false,
      error: `Adding this would exceed the knowledge limit (${MAX_TOTAL_KNOWLEDGE_CHARS} chars). Current: ${currentChars}, adding: ${data.content.length}`,
    };
  }

  const now = Date.now();
  const item: KnowledgeItem = {
    id,
    agent: data.agent,
    title: data.title,
    content: data.content,
    priority: data.priority,
    createdAt: knowledgeStore.get(id)?.createdAt ?? now,
    updatedAt: now,
  };
  knowledgeStore.set(id, item);
  persist();
  return { ok: true, item };
}

export function updateKnowledge(
  id: string,
  updates: Partial<Pick<KnowledgeItem, "title" | "content" | "priority">>
): KnowledgeItem | null {
  const existing = knowledgeStore.get(id);
  if (!existing) return null;

  if (updates.content !== undefined) {
    const currentChars = totalKnowledgeChars(id);
    if (currentChars + updates.content.length > MAX_TOTAL_KNOWLEDGE_CHARS) {
      return null;
    }
  }

  const updated = { ...existing, ...updates, updatedAt: Date.now() };
  knowledgeStore.set(id, updated);
  persist();
  return updated;
}

export function deleteKnowledge(id: string): boolean {
  const deleted = knowledgeStore.delete(id);
  if (deleted) persist();
  return deleted;
}

export function getKnowledge(id: string): KnowledgeItem | null {
  return knowledgeStore.get(id) ?? null;
}

export function listKnowledge(agent?: string): KnowledgeItem[] {
  const items = Array.from(knowledgeStore.values());
  const filtered = agent ? items.filter((k) => k.agent === agent) : items;
  return filtered.sort((a, b) => a.priority - b.priority);
}

// ── Secrets ──

function isExpired(entry: SecretEntry): boolean {
  return !!entry.expiresAt && entry.expiresAt < Date.now();
}

export function setSecret(key: string, value: string, expiresAt?: number): { ok: true } | { ok: false; error: string } {
  const parsed = SecretSchema.safeParse({ key, value, expiresAt });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.flatten().fieldErrors.toString() };
  }
  secretsStore.set(key, { key, value, expiresAt });
  process.env[key] = value;
  persist();
  return { ok: true };
}

export function deleteSecret(key: string): void {
  secretsStore.delete(key);
  delete process.env[key];
  persist();
}

export function listSecretKeys(): Array<{ key: string; expiresAt?: number; expired: boolean }> {
  return Array.from(secretsStore.values()).map((e) => ({
    key: e.key,
    expiresAt: e.expiresAt,
    expired: isExpired(e),
  }));
}

export function hasSecret(key: string): boolean {
  const entry = secretsStore.get(key);
  if (entry && isExpired(entry)) {
    deleteSecret(key);
    return false;
  }
  return !!entry || !!process.env[key];
}

/** Prune expired secrets. Call on interval or at startup. */
export function pruneExpiredSecrets(): number {
  let pruned = 0;
  for (const [key, entry] of secretsStore) {
    if (isExpired(entry)) {
      deleteSecret(key);
      pruned++;
    }
  }
  return pruned;
}

// ── Bulk setup ──

export function bulkSetup(input: z.infer<typeof BulkSetupSchema>): {
  knowledge: Array<{ id: string; ok: boolean; error?: string }>;
  secrets: Array<{ key: string; ok: boolean; error?: string }>;
} {
  const parsed = BulkSetupSchema.safeParse(input);
  if (!parsed.success) {
    return { knowledge: [], secrets: [{ key: "schema", ok: false, error: parsed.error.message }] };
  }

  const results = {
    knowledge: [] as Array<{ id: string; ok: boolean; error?: string }>,
    secrets: [] as Array<{ key: string; ok: boolean; error?: string }>,
  };

  for (const item of parsed.data.knowledge ?? []) {
    const result = addKnowledge(item);
    if (result.ok) {
      results.knowledge.push({ id: result.item.id, ok: true });
    } else {
      results.knowledge.push({ id: item.id ?? "unknown", ok: false, error: result.error });
    }
  }

  for (const secret of parsed.data.secrets ?? []) {
    const result = setSecret(secret.key, secret.value, secret.expiresAt);
    if (result.ok) {
      results.secrets.push({ key: secret.key, ok: true });
    } else {
      results.secrets.push({ key: secret.key, ok: false, error: result.error });
    }
  }

  return results;
}

// ── Build system prompt with knowledge ──

export function buildSystemPrompt(baseInstructions: string, agentName: string): string {
  // Prune expired secrets before each run
  pruneExpiredSecrets();

  const items = listKnowledge(agentName);
  if (items.length === 0) return baseInstructions;

  const knowledgeSections = items
    .map((k) => `## ${k.title}\n\n${k.content}`)
    .join("\n\n---\n\n");

  return `${baseInstructions}\n\n---\n\n# Knowledge & Skills\n\nThe following knowledge has been provided to help you accomplish tasks:\n\n${knowledgeSections}`;
}
