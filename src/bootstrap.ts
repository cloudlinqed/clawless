import { loadConfig } from "./config/loader.js";
import { setPersistence, loadFromPersistence } from "./config/knowledge.js";
import { setToolPersistence, loadToolsFromPersistence } from "./config/tool-store.js";
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
      setSessionStore(persistence);
      setMemoStore(persistence);

      await Promise.all([loadFromPersistence(), loadToolsFromPersistence()]);
      return;
    }

    const filePersistence = new FilePersistence();
    setPersistence(filePersistence);
    setToolPersistence(filePersistence);
    setSessionStore(new MemorySessionStore());
    setMemoStore(new MemoryMemoStore());

    await Promise.all([loadFromPersistence(), loadToolsFromPersistence()]);
  })();

  await initPromise;
}
