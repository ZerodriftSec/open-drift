import { createClient, type Client } from "@libsql/client";
import { access, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

type SqliteClient = Client;

function createDrizzleDatabase(client: SqliteClient) {
  return drizzle({ client });
}

export type AppDb = ReturnType<typeof createDrizzleDatabase>;
export type AppTransaction = Parameters<Parameters<AppDb["transaction"]>[0]>[0];
export type DbExecutor = AppDb | AppTransaction;

type DbEntry = {
  client: SqliteClient;
  db: AppDb;
};

const globalForDb = globalThis as unknown as {
  auditWorkbenchDbByUrl?: Map<string, DbEntry>;
  auditWorkbenchDbOpenings?: Map<string, Promise<DbEntry>>;
  auditWorkbenchMigrationVersions?: Map<string, string>;
  auditWorkbenchMigrationOpenings?: Map<string, Promise<void>>;
};

const databaseUrl = "file:.data/data.sqlite";

export async function migrateDatabase() {
  const url = databaseUrl;
  const folder = await migrationsFolder();
  const version = await migrationFolderVersion(folder);

  globalForDb.auditWorkbenchMigrationVersions ??= new Map();
  if (globalForDb.auditWorkbenchMigrationVersions.get(url) === version) {
    return;
  }

  globalForDb.auditWorkbenchMigrationOpenings ??= new Map();
  const existingMigration =
    globalForDb.auditWorkbenchMigrationOpenings.get(url);
  if (existingMigration) {
    return existingMigration;
  }

  const migration = (async () => {
    const databasePath = sqliteFilePath(url);
    if (databasePath && databasePath !== ":memory:") {
      await mkdir(path.dirname(databasePath), { recursive: true });
    }

    const client = createClient({ url });
    try {
      if (url.startsWith("file:")) {
        await client.execute("PRAGMA journal_mode = WAL");
      }
      await client.execute("PRAGMA foreign_keys = ON");
      await migrate(createDrizzleDatabase(client), {
        migrationsFolder: folder,
      });
      globalForDb.auditWorkbenchMigrationVersions?.set(url, version);
    } finally {
      client.close();
    }
  })();

  globalForDb.auditWorkbenchMigrationOpenings.set(url, migration);
  try {
    await migration;
  } finally {
    globalForDb.auditWorkbenchMigrationOpenings.delete(url);
  }
}

function sqliteFilePath(url: string) {
  if (!url.startsWith("file:")) {
    return undefined;
  }

  return url.slice("file:".length).split("?")[0];
}

async function migrationsFolder() {
  const folder =
    process.env.DRIZZLE_MIGRATIONS_FOLDER ??
    path.join(process.cwd(), "drizzle");
  try {
    await access(folder);
  } catch {
    throw new Error(`Drizzle migrations folder not found: ${folder}`);
  }

  return folder;
}

export async function getDb() {
  await migrateDatabase();

  const url = databaseUrl;
  globalForDb.auditWorkbenchDbByUrl ??= new Map();
  const existingEntry = globalForDb.auditWorkbenchDbByUrl.get(url);
  if (existingEntry) {
    return existingEntry.db;
  }

  globalForDb.auditWorkbenchDbOpenings ??= new Map();
  const existingOpening = globalForDb.auditWorkbenchDbOpenings.get(url);
  if (existingOpening) {
    return (await existingOpening).db;
  }

  const opening = (async () => {
    const client = createClient({ url });
    await client.execute("PRAGMA foreign_keys = ON");
    const entry = {
      client,
      db: createDrizzleDatabase(client),
    };
    globalForDb.auditWorkbenchDbByUrl?.set(url, entry);
    return entry;
  })();

  globalForDb.auditWorkbenchDbOpenings.set(url, opening);
  try {
    return (await opening).db;
  } finally {
    globalForDb.auditWorkbenchDbOpenings.delete(url);
  }
}

async function migrationFolderVersion(folder: string) {
  return `${folder}:${(await stat(folder)).mtimeMs}`;
}

export async function closeDb() {
  const openings = globalForDb.auditWorkbenchDbOpenings?.values() ?? [];
  await Promise.all([...openings]);

  for (const { client } of globalForDb.auditWorkbenchDbByUrl?.values() ?? []) {
    client.close();
  }
  globalForDb.auditWorkbenchDbByUrl = undefined;
  globalForDb.auditWorkbenchDbOpenings = undefined;
  globalForDb.auditWorkbenchMigrationVersions = undefined;
  globalForDb.auditWorkbenchMigrationOpenings = undefined;
}
