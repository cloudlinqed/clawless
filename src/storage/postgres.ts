import { Pool } from "pg";
import type { ConfigDraft, ConfigLifecyclePersistence, ConfigRelease } from "../config/lifecycle.js";
import type { KnowledgeItem, KnowledgePersistence, SecretEntry } from "../config/knowledge.js";
import type { StoredToolConfig, ToolPersistence } from "../config/tool-store.js";
import type { SessionData, SessionStore } from "../session/store.js";
import type { MemoEntry, MemoStore } from "../memo/store.js";

function envFlag(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function getConnectionString(): string {
  const value =
    process.env.DATABASE_URL ??
    process.env.POSTGRES_URL ??
    process.env.SUPABASE_DB_URL;

  if (!value) {
    throw new Error("DATABASE_URL, POSTGRES_URL, or SUPABASE_DB_URL is required for postgres persistence");
  }

  return value;
}

export class PostgresPersistence implements KnowledgePersistence, ToolPersistence, ConfigLifecyclePersistence, SessionStore, MemoStore {
  private pool: Pool;
  private initPromise: Promise<void> | null = null;
  private tablePrefix: string;

  constructor() {
    const ssl =
      process.env.DATABASE_SSL !== undefined
        ? envFlag(process.env.DATABASE_SSL)
        : getConnectionString().includes("sslmode=require");

    this.pool = new Pool({
      connectionString: getConnectionString(),
      ssl: ssl ? { rejectUnauthorized: false } : undefined,
    });
    this.tablePrefix = process.env.DATABASE_TABLE_PREFIX ?? "clawless";
  }

  async ensureReady(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.init();
    }
    await this.initPromise;
  }

  private table(name: string): string {
    return `${this.tablePrefix}_${name}`;
  }

  private async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table("knowledge")} (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        priority INTEGER NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ${this.table("secrets")} (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at BIGINT NULL
      );

      CREATE TABLE IF NOT EXISTS ${this.table("tools")} (
        name TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        config JSONB NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ${this.table("config_drafts")} (
        environment TEXT PRIMARY KEY,
        snapshot JSONB NOT NULL,
        updated_at BIGINT NOT NULL,
        base_release_id TEXT NULL
      );

      CREATE TABLE IF NOT EXISTS ${this.table("config_releases")} (
        id TEXT PRIMARY KEY,
        environment TEXT NOT NULL,
        version INTEGER NOT NULL,
        snapshot JSONB NOT NULL,
        created_at BIGINT NOT NULL,
        published_at BIGINT NOT NULL,
        note TEXT NULL,
        source_release_id TEXT NULL,
        source_environment TEXT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS ${this.table("config_releases")}_env_version_idx
      ON ${this.table("config_releases")} (environment, version);

      CREATE TABLE IF NOT EXISTS ${this.table("sessions")} (
        id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        tool_set TEXT NOT NULL,
        messages JSONB NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (id, user_id)
      );

      CREATE INDEX IF NOT EXISTS ${this.table("sessions")}_user_updated_idx
      ON ${this.table("sessions")} (user_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS ${this.table("memos")} (
        user_id TEXT NOT NULL,
        memo_key TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, memo_key)
      );

      CREATE INDEX IF NOT EXISTS ${this.table("memos")}_user_updated_idx
      ON ${this.table("memos")} (user_id, updated_at DESC);
    `);
  }

  async loadKnowledge(): Promise<KnowledgeItem[]> {
    await this.ensureReady();
    const result = await this.pool.query(`
      SELECT id, agent, title, content, priority, created_at, updated_at
      FROM ${this.table("knowledge")}
      ORDER BY priority ASC, updated_at DESC
    `);

    return result.rows.map((row: any) => ({
      id: String(row.id),
      agent: String(row.agent),
      title: String(row.title),
      content: String(row.content),
      priority: Number(row.priority),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }));
  }

  async saveKnowledge(items: KnowledgeItem[]): Promise<void> {
    await this.ensureReady();
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM ${this.table("knowledge")}`);
      for (const item of items) {
        await client.query(
          `
            INSERT INTO ${this.table("knowledge")}
              (id, agent, title, content, priority, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
          `,
          [item.id, item.agent, item.title, item.content, item.priority, item.createdAt, item.updatedAt]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async loadSecrets(): Promise<SecretEntry[]> {
    await this.ensureReady();
    const result = await this.pool.query(`
      SELECT key, value, expires_at
      FROM ${this.table("secrets")}
    `);

    return result.rows.map((row: any) => ({
      key: String(row.key),
      value: String(row.value),
      expiresAt: row.expires_at === null ? undefined : Number(row.expires_at),
    }));
  }

  async saveSecrets(entries: SecretEntry[]): Promise<void> {
    await this.ensureReady();
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM ${this.table("secrets")}`);
      for (const entry of entries) {
        await client.query(
          `
            INSERT INTO ${this.table("secrets")}
              (key, value, expires_at)
            VALUES ($1, $2, $3)
          `,
          [entry.key, entry.value, entry.expiresAt ?? null]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async loadTools(): Promise<StoredToolConfig[]> {
    await this.ensureReady();
    const result = await this.pool.query(`
      SELECT config
      FROM ${this.table("tools")}
      ORDER BY updated_at DESC
    `);

    return result.rows.map((row: any) => row.config as StoredToolConfig);
  }

  async saveTools(tools: StoredToolConfig[]): Promise<void> {
    await this.ensureReady();
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM ${this.table("tools")}`);
      for (const tool of tools) {
        await client.query(
          `
            INSERT INTO ${this.table("tools")}
              (name, agent, config, created_at, updated_at)
            VALUES ($1, $2, $3::jsonb, $4, $5)
          `,
          [tool.name, tool.agent, JSON.stringify(tool), tool.createdAt, tool.updatedAt]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async loadConfigDrafts(): Promise<ConfigDraft[]> {
    await this.ensureReady();
    const result = await this.pool.query(`
      SELECT environment, snapshot, updated_at, base_release_id
      FROM ${this.table("config_drafts")}
      ORDER BY environment ASC
    `);

    return result.rows.map((row: any) => ({
      environment: String(row.environment),
      snapshot: row.snapshot as ConfigDraft["snapshot"],
      updatedAt: Number(row.updated_at),
      baseReleaseId: row.base_release_id === null ? undefined : String(row.base_release_id),
    }));
  }

  async saveConfigDrafts(drafts: ConfigDraft[]): Promise<void> {
    await this.ensureReady();
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM ${this.table("config_drafts")}`);
      for (const draft of drafts) {
        await client.query(
          `
            INSERT INTO ${this.table("config_drafts")}
              (environment, snapshot, updated_at, base_release_id)
            VALUES ($1, $2::jsonb, $3, $4)
          `,
          [draft.environment, JSON.stringify(draft.snapshot), draft.updatedAt, draft.baseReleaseId ?? null]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async loadConfigReleases(): Promise<ConfigRelease[]> {
    await this.ensureReady();
    const result = await this.pool.query(`
      SELECT id, environment, version, snapshot, created_at, published_at, note, source_release_id, source_environment
      FROM ${this.table("config_releases")}
      ORDER BY environment ASC, version ASC
    `);

    return result.rows.map((row: any) => ({
      id: String(row.id),
      environment: String(row.environment),
      version: Number(row.version),
      snapshot: row.snapshot as ConfigRelease["snapshot"],
      createdAt: Number(row.created_at),
      publishedAt: Number(row.published_at),
      note: row.note === null ? undefined : String(row.note),
      sourceReleaseId: row.source_release_id === null ? undefined : String(row.source_release_id),
      sourceEnvironment: row.source_environment === null ? undefined : String(row.source_environment),
    }));
  }

  async saveConfigReleases(entries: ConfigRelease[]): Promise<void> {
    await this.ensureReady();
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM ${this.table("config_releases")}`);
      for (const entry of entries) {
        await client.query(
          `
            INSERT INTO ${this.table("config_releases")}
              (id, environment, version, snapshot, created_at, published_at, note, source_release_id, source_environment)
            VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)
          `,
          [
            entry.id,
            entry.environment,
            entry.version,
            JSON.stringify(entry.snapshot),
            entry.createdAt,
            entry.publishedAt,
            entry.note ?? null,
            entry.sourceReleaseId ?? null,
            entry.sourceEnvironment ?? null,
          ]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async load(id: string, userId: string): Promise<SessionData | null> {
    await this.ensureReady();
    const result = await this.pool.query(
      `
        SELECT id, user_id, tool_set, messages, created_at, updated_at
        FROM ${this.table("sessions")}
        WHERE id = $1 AND user_id = $2
        LIMIT 1
      `,
      [id, userId]
    );

    const row = result.rows[0];
    if (!row) return null;

    return {
      id: String(row.id),
      userId: String(row.user_id),
      toolSet: String(row.tool_set),
      messages: row.messages as SessionData["messages"],
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  async save(session: SessionData): Promise<void> {
    await this.ensureReady();
    await this.pool.query(
      `
        INSERT INTO ${this.table("sessions")}
          (id, user_id, tool_set, messages, created_at, updated_at)
        VALUES ($1, $2, $3, $4::jsonb, $5, $6)
        ON CONFLICT (id, user_id)
        DO UPDATE SET
          tool_set = EXCLUDED.tool_set,
          messages = EXCLUDED.messages,
          created_at = EXCLUDED.created_at,
          updated_at = EXCLUDED.updated_at
      `,
      [
        session.id,
        session.userId,
        session.toolSet,
        JSON.stringify(session.messages),
        session.createdAt,
        session.updatedAt,
      ]
    );
  }

  async delete(id: string, userId: string): Promise<void> {
    await this.ensureReady();
    await this.pool.query(
      `DELETE FROM ${this.table("sessions")} WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
  }

  async list(userId: string): Promise<Array<{ id: string; toolSet: string; updatedAt: number }>> {
    await this.ensureReady();
    const result = await this.pool.query(
      `
        SELECT id, tool_set, updated_at
        FROM ${this.table("sessions")}
        WHERE user_id = $1
        ORDER BY updated_at DESC
      `,
      [userId]
    );

    return result.rows.map((row: any) => ({
      id: String(row.id),
      toolSet: String(row.tool_set),
      updatedAt: Number(row.updated_at),
    }));
  }

  async getMemo(userId: string, key: string): Promise<MemoEntry | null> {
    await this.ensureReady();
    const result = await this.pool.query(
      `
        SELECT user_id, memo_key, content, created_at, updated_at
        FROM ${this.table("memos")}
        WHERE user_id = $1 AND memo_key = $2
        LIMIT 1
      `,
      [userId, key]
    );

    const row = result.rows[0];
    if (!row) return null;

    return {
      userId: String(row.user_id),
      key: String(row.memo_key),
      content: String(row.content),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  async setMemo(userId: string, key: string, content: string): Promise<MemoEntry> {
    await this.ensureReady();
    const now = Date.now();
    const existing = await this.getMemo(userId, key);

    await this.pool.query(
      `
        INSERT INTO ${this.table("memos")}
          (user_id, memo_key, content, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (user_id, memo_key)
        DO UPDATE SET
          content = EXCLUDED.content,
          updated_at = EXCLUDED.updated_at
      `,
      [userId, key, content, existing?.createdAt ?? now, now]
    );

    return {
      userId,
      key,
      content,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
  }

  async deleteMemo(userId: string, key: string): Promise<void> {
    await this.ensureReady();
    await this.pool.query(
      `DELETE FROM ${this.table("memos")} WHERE user_id = $1 AND memo_key = $2`,
      [userId, key]
    );
  }

  async listMemos(userId: string): Promise<MemoEntry[]> {
    await this.ensureReady();
    const result = await this.pool.query(
      `
        SELECT user_id, memo_key, content, created_at, updated_at
        FROM ${this.table("memos")}
        WHERE user_id = $1
        ORDER BY updated_at DESC
      `,
      [userId]
    );

    return result.rows.map((row: any) => ({
      userId: String(row.user_id),
      key: String(row.memo_key),
      content: String(row.content),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }));
  }
}
