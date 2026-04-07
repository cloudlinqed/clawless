import fs from "node:fs/promises";
import path from "node:path";
import type { KnowledgeItem, KnowledgePersistence, SecretEntry } from "./knowledge.js";

/**
 * File-based persistence for knowledge and secrets.
 * Stores as JSON files in a configurable directory.
 * Simple, works locally and on serverless with mounted volumes.
 */
export class FilePersistence implements KnowledgePersistence {
  private dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? process.env.DATA_DIR ?? path.resolve(process.cwd(), ".clawless");
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  async loadKnowledge(): Promise<KnowledgeItem[]> {
    try {
      const data = await fs.readFile(path.join(this.dir, "knowledge.json"), "utf-8");
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  async saveKnowledge(items: KnowledgeItem[]): Promise<void> {
    await this.ensureDir();
    await fs.writeFile(path.join(this.dir, "knowledge.json"), JSON.stringify(items, null, 2));
  }

  async loadSecrets(): Promise<SecretEntry[]> {
    try {
      const data = await fs.readFile(path.join(this.dir, "secrets.json"), "utf-8");
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  async saveSecrets(entries: SecretEntry[]): Promise<void> {
    await this.ensureDir();
    await fs.writeFile(path.join(this.dir, "secrets.json"), JSON.stringify(entries, null, 2));
  }
}
