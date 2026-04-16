import { loadConfig } from "./config/loader.js";
import { exportBaseRuntimeAgentConfigs } from "./config/agent-def.js";
import { initializeConfigLifecycle, setConfigLifecyclePersistence } from "./config/lifecycle.js";
import { setPersistence, loadFromPersistence, exportBaseKnowledgeSnapshot } from "./config/knowledge.js";
import { setToolPersistence, loadToolsFromPersistence, exportBaseToolSnapshot } from "./config/tool-store.js";
import { FilePersistence } from "./config/knowledge-persistence.js";
import { setSessionStore } from "./session/index.js";
import { MemorySessionStore } from "./session/memory.js";
import { setMemoStore } from "./memo/index.js";
import { MemoryMemoStore } from "./memo/memory.js";
import { PostgresPersistence } from "./storage/postgres.js";

let initPromise: Promise<void> | null = null;

function shouldUsePostgres(): boolean {
  const driver = process.env.PERSISTENCE_DRIVER?.toLowerCase();
  if (driver === "postgres") return true;
  if (driver === "file") return false;
  return Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.SUPABASE_DB_URL);
}

export async function initializeClawless(): Promise<void> {
  if (initPromise) {
    await initPromise;
    return;
  }

  initPromise = (async () => {
    await loadConfig();

    if (shouldUsePostgres()) {
      const persistence = new PostgresPersistence();
      await persistence.ensureReady();

      setPersistence(persistence);
      setToolPersistence(persistence);
      setConfigLifecyclePersistence(persistence);
      setSessionStore(persistence);
      setMemoStore(persistence);

      await Promise.all([loadFromPersistence(), loadToolsFromPersistence()]);
      await initializeConfigLifecycle({
        agents: exportBaseRuntimeAgentConfigs(),
        knowledge: exportBaseKnowledgeSnapshot(),
        tools: exportBaseToolSnapshot(),
      });
      return;
    }

    const filePersistence = new FilePersistence();
    setPersistence(filePersistence);
    setToolPersistence(filePersistence);
    setConfigLifecyclePersistence(filePersistence);
    setSessionStore(new MemorySessionStore());
    setMemoStore(new MemoryMemoStore());

    await Promise.all([loadFromPersistence(), loadToolsFromPersistence()]);
    await initializeConfigLifecycle({
      agents: exportBaseRuntimeAgentConfigs(),
      knowledge: exportBaseKnowledgeSnapshot(),
      tools: exportBaseToolSnapshot(),
    });
  })();

  await initPromise;
}
