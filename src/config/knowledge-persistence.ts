import fs from "node:fs/promises";
import path from "node:path";
import type { KnowledgeItem, KnowledgePersistence, SecretEntry } from "./knowledge.js";
import type { ConfigDraft, ConfigLifecyclePersistence, ConfigRelease } from "./lifecycle.js";
import type { StoredToolConfig, ToolPersistence } from "./tool-store.js";

/**
 * File-based persistence for knowledge, secrets, and tools.
 * Stores as JSON files in a configurable directory.
 */
export class FilePersistence implements KnowledgePersistence, ToolPersistence, ConfigLifecyclePersistence {
  private dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? process.env.DATA_DIR ?? path.resolve(process.cwd(), ".clawless");
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  private async readJson<T>(file: string): Promise<T[]> {
    try {
      const data = await fs.readFile(path.join(this.dir, file), "utf-8");
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  private async writeJson(file: string, data: unknown): Promise<void> {
    await this.ensureDir();
    await fs.writeFile(path.join(this.dir, file), JSON.stringify(data, null, 2));
  }

  async loadKnowledge(): Promise<KnowledgeItem[]> {
    return this.readJson("knowledge.json");
  }

  async saveKnowledge(items: KnowledgeItem[]): Promise<void> {
    return this.writeJson("knowledge.json", items);
  }

  async loadSecrets(): Promise<SecretEntry[]> {
    return this.readJson("secrets.json");
  }

  async saveSecrets(entries: SecretEntry[]): Promise<void> {
    return this.writeJson("secrets.json", entries);
  }

  async loadTools(): Promise<StoredToolConfig[]> {
    return this.readJson("tools.json");
  }

  async saveTools(tools: StoredToolConfig[]): Promise<void> {
    return this.writeJson("tools.json", tools);
  }

  async loadConfigDrafts(): Promise<ConfigDraft[]> {
    return this.readJson("config-drafts.json");
  }

  async saveConfigDrafts(drafts: ConfigDraft[]): Promise<void> {
    return this.writeJson("config-drafts.json", drafts);
  }

  async loadConfigReleases(): Promise<ConfigRelease[]> {
    return this.readJson("config-releases.json");
  }

  async saveConfigReleases(releases: ConfigRelease[]): Promise<void> {
    return this.writeJson("config-releases.json", releases);
  }
}
