import type { KnowledgeItem } from "./knowledge.js";
import type { StoredToolConfig } from "./tool-store.js";
import type { RuntimeAgentConfig } from "./runtime-agent-config.js";

export type ConfigStage = "draft" | "published";

export interface ConfigSnapshot {
  agents: RuntimeAgentConfig[];
  knowledge: KnowledgeItem[];
  tools: StoredToolConfig[];
}

export interface ConfigDraft {
  environment: string;
  snapshot: ConfigSnapshot;
  updatedAt: number;
  baseReleaseId?: string;
}

export interface ConfigRelease {
  id: string;
  environment: string;
  version: number;
  snapshot: ConfigSnapshot;
  createdAt: number;
  publishedAt: number;
  note?: string;
  sourceReleaseId?: string;
  sourceEnvironment?: string;
}

export interface ConfigLifecyclePersistence {
  loadConfigDrafts(): Promise<ConfigDraft[]>;
  saveConfigDrafts(drafts: ConfigDraft[]): Promise<void>;
  loadConfigReleases(): Promise<ConfigRelease[]>;
  saveConfigReleases(releases: ConfigRelease[]): Promise<void>;
}

const drafts = new Map<string, ConfigDraft>();
const releases = new Map<string, ConfigRelease[]>();
let persistence: ConfigLifecyclePersistence | null = null;
let lifecycleEnabled = false;
let baseSnapshot: ConfigSnapshot = { agents: [], knowledge: [], tools: [] };

export function setConfigLifecyclePersistence(next: ConfigLifecyclePersistence): void {
  persistence = next;
}

export function isConfigLifecycleEnabled(): boolean {
  return lifecycleEnabled;
}

export function getRuntimeConfigEnvironment(): string {
  return (
    process.env.CONFIG_ENV ??
    process.env.CLAWLESS_ENV ??
    (process.env.NODE_ENV === "production" ? "production" : "development")
  ).trim();
}

export function getRuntimeConfigStage(): ConfigStage {
  const explicit = process.env.CONFIG_STAGE?.trim().toLowerCase();
  if (explicit === "draft" || explicit === "published") {
    return explicit;
  }
  return process.env.NODE_ENV === "production" ? "published" : "draft";
}

export async function initializeConfigLifecycle(initial: ConfigSnapshot): Promise<void> {
  baseSnapshot = cloneSnapshot(initial);
  drafts.clear();
  releases.clear();

  if (persistence) {
    const [loadedDrafts, loadedReleases] = await Promise.all([
      persistence.loadConfigDrafts(),
      persistence.loadConfigReleases(),
    ]);

    for (const draft of loadedDrafts) {
      drafts.set(draft.environment, normalizeDraft(draft));
    }

    for (const release of loadedReleases) {
      const list = releases.get(release.environment) ?? [];
      list.push(normalizeRelease(release));
      releases.set(release.environment, list);
    }
  }

  ensureEnvironment(getRuntimeConfigEnvironment());
  lifecycleEnabled = true;
  void persistLifecycle();
}

export function resetConfigLifecycleForTests(): void {
  drafts.clear();
  releases.clear();
  lifecycleEnabled = false;
  baseSnapshot = { agents: [], knowledge: [], tools: [] };
  persistence = null;
}

export function listConfigEnvironments(): string[] {
  const names = new Set<string>([getRuntimeConfigEnvironment()]);
  for (const key of drafts.keys()) names.add(key);
  for (const key of releases.keys()) names.add(key);
  return Array.from(names).sort();
}

export function getConfigSnapshot(options?: {
  environment?: string;
  stage?: ConfigStage;
}): ConfigSnapshot {
  if (!lifecycleEnabled) {
    return cloneSnapshot(baseSnapshot);
  }

  const environment = resolveEnvironment(options?.environment);
  const stage = options?.stage ?? getRuntimeConfigStage();
  ensureEnvironment(environment);

  if (stage === "draft") {
    return cloneSnapshot(drafts.get(environment)!.snapshot);
  }

  return cloneSnapshot(getLatestPublished(environment).snapshot);
}

export function mutateDraftSnapshot<T>(
  environment: string | undefined,
  updater: (snapshot: ConfigSnapshot) => T
): T {
  const env = resolveEnvironment(environment);
  if (!lifecycleEnabled) {
    const working = cloneSnapshot(baseSnapshot);
    const result = updater(working);
    baseSnapshot = working;
    return result;
  }

  ensureEnvironment(env);
  const draft = drafts.get(env)!;
  const nextSnapshot = cloneSnapshot(draft.snapshot);
  const result = updater(nextSnapshot);
  drafts.set(env, {
    environment: env,
    snapshot: nextSnapshot,
    updatedAt: Date.now(),
    baseReleaseId: draft.baseReleaseId,
  });
  void persistLifecycle();
  return result;
}

export function replaceDraftSnapshot(
  environment: string | undefined,
  snapshot: ConfigSnapshot,
  baseReleaseId?: string
): ConfigDraft {
  const env = resolveEnvironment(environment);
  ensureEnvironment(env);
  const draft: ConfigDraft = {
    environment: env,
    snapshot: cloneSnapshot(snapshot),
    updatedAt: Date.now(),
    baseReleaseId,
  };
  drafts.set(env, draft);
  void persistLifecycle();
  return cloneDraft(draft);
}

export function listConfigReleases(environment?: string): ConfigRelease[] {
  if (!lifecycleEnabled) return [];
  const env = resolveEnvironment(environment);
  ensureEnvironment(env);
  return getReleases(env).map(cloneRelease).sort((a, b) => b.version - a.version);
}

export function getConfigRelease(environment: string | undefined, idOrVersion: string | number): ConfigRelease | null {
  const env = resolveEnvironment(environment);
  ensureEnvironment(env);
  const release = getReleases(env).find((entry) => entry.id === String(idOrVersion) || entry.version === Number(idOrVersion));
  return release ? cloneRelease(release) : null;
}

export function getConfigStatus(environment?: string): {
  environment: string;
  stage: ConfigStage;
  draftUpdatedAt: number;
  published: Pick<ConfigRelease, "id" | "version" | "publishedAt" | "note"> | null;
  releaseCount: number;
} {
  const env = resolveEnvironment(environment);
  ensureEnvironment(env);
  const draft = drafts.get(env)!;
  const published = getLatestPublished(env);
  return {
    environment: env,
    stage: getRuntimeConfigStage(),
    draftUpdatedAt: draft.updatedAt,
    published: published
      ? {
          id: published.id,
          version: published.version,
          publishedAt: published.publishedAt,
          note: published.note,
        }
      : null,
    releaseCount: getReleases(env).length,
  };
}

export function publishDraft(input?: {
  environment?: string;
  note?: string;
  sourceReleaseId?: string;
  sourceEnvironment?: string;
}): ConfigRelease {
  const environment = resolveEnvironment(input?.environment);
  ensureEnvironment(environment);

  const draft = drafts.get(environment)!;
  const current = getLatestPublished(environment);
  const release: ConfigRelease = {
    id: crypto.randomUUID(),
    environment,
    version: current ? current.version + 1 : 1,
    snapshot: cloneSnapshot(draft.snapshot),
    createdAt: Date.now(),
    publishedAt: Date.now(),
    note: input?.note,
    sourceReleaseId: input?.sourceReleaseId,
    sourceEnvironment: input?.sourceEnvironment,
  };

  const list = getReleases(environment);
  list.push(release);
  releases.set(environment, list);

  drafts.set(environment, {
    environment,
    snapshot: cloneSnapshot(release.snapshot),
    updatedAt: Date.now(),
    baseReleaseId: release.id,
  });

  void persistLifecycle();
  return cloneRelease(release);
}

export function rollbackConfig(input: {
  environment?: string;
  releaseId?: string;
  version?: number;
  note?: string;
}): ConfigRelease | null {
  const environment = resolveEnvironment(input.environment);
  ensureEnvironment(environment);
  const target = input.releaseId
    ? getConfigRelease(environment, input.releaseId)
    : input.version !== undefined
      ? getConfigRelease(environment, input.version)
      : listConfigReleases(environment)[0] ?? null;

  if (!target) {
    return null;
  }

  replaceDraftSnapshot(environment, target.snapshot, target.id);
  return publishDraft({
    environment,
    note: input.note ?? `Rollback to version ${target.version}`,
    sourceReleaseId: target.id,
    sourceEnvironment: environment,
  });
}

export function promoteConfig(input: {
  sourceEnvironment: string;
  targetEnvironment: string;
  releaseId?: string;
  version?: number;
  publish?: boolean;
  note?: string;
}): {
  draft: ConfigDraft;
  release: ConfigRelease | null;
} | null {
  ensureEnvironment(resolveEnvironment(input.sourceEnvironment));
  ensureEnvironment(resolveEnvironment(input.targetEnvironment));

  const sourceRelease = input.releaseId
    ? getConfigRelease(input.sourceEnvironment, input.releaseId)
    : input.version !== undefined
      ? getConfigRelease(input.sourceEnvironment, input.version)
      : listConfigReleases(input.sourceEnvironment)[0] ?? null;

  if (!sourceRelease) {
    return null;
  }

  const draft = replaceDraftSnapshot(input.targetEnvironment, sourceRelease.snapshot, sourceRelease.id);
  const release = input.publish
    ? publishDraft({
        environment: input.targetEnvironment,
        note: input.note ?? `Promoted from ${input.sourceEnvironment} v${sourceRelease.version}`,
        sourceReleaseId: sourceRelease.id,
        sourceEnvironment: input.sourceEnvironment,
      })
    : null;

  return { draft, release };
}

function resolveEnvironment(environment?: string): string {
  return (environment ?? getRuntimeConfigEnvironment()).trim();
}

function ensureEnvironment(environment: string): void {
  if (!releases.has(environment) || getReleases(environment).length === 0) {
    const bootstrap = createBootstrapRelease(environment);
    releases.set(environment, [bootstrap]);
  }

  if (!drafts.has(environment)) {
    const latest = getLatestPublished(environment);
    drafts.set(environment, {
      environment,
      snapshot: cloneSnapshot(latest.snapshot),
      updatedAt: latest.publishedAt,
      baseReleaseId: latest.id,
    });
  }
}

function createBootstrapRelease(environment: string): ConfigRelease {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    environment,
    version: 1,
    snapshot: cloneSnapshot(baseSnapshot),
    createdAt: now,
    publishedAt: now,
    note: "Bootstrap release",
  };
}

function getLatestPublished(environment: string): ConfigRelease {
  const list = getReleases(environment);
  const latest = list.reduce<ConfigRelease | null>((best, entry) => {
    if (!best || entry.version > best.version) return entry;
    return best;
  }, null);

  if (!latest) {
    throw new Error(`No published release found for environment "${environment}"`);
  }

  return latest;
}

function getReleases(environment: string): ConfigRelease[] {
  return releases.get(environment) ?? [];
}

async function persistLifecycle(): Promise<void> {
  if (!persistence) return;
  await Promise.all([
    persistence.saveConfigDrafts(Array.from(drafts.values()).map(cloneDraft)),
    persistence.saveConfigReleases(Array.from(releases.values()).flat().map(cloneRelease)),
  ]);
}

function normalizeDraft(draft: ConfigDraft): ConfigDraft {
  return {
    environment: draft.environment,
    snapshot: normalizeSnapshot(draft.snapshot),
    updatedAt: draft.updatedAt,
    baseReleaseId: draft.baseReleaseId,
  };
}

function normalizeRelease(release: ConfigRelease): ConfigRelease {
  return {
    ...release,
    snapshot: normalizeSnapshot(release.snapshot),
  };
}

function normalizeSnapshot(snapshot: ConfigSnapshot): ConfigSnapshot {
  return {
    agents: clone(snapshot.agents ?? []),
    knowledge: clone(snapshot.knowledge ?? []),
    tools: clone(snapshot.tools ?? []),
  };
}

function cloneSnapshot(snapshot: ConfigSnapshot): ConfigSnapshot {
  return normalizeSnapshot(snapshot);
}

function cloneRelease(release: ConfigRelease): ConfigRelease {
  return {
    ...release,
    snapshot: cloneSnapshot(release.snapshot),
  };
}

function cloneDraft(draft: ConfigDraft): ConfigDraft {
  return {
    ...draft,
    snapshot: cloneSnapshot(draft.snapshot),
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
