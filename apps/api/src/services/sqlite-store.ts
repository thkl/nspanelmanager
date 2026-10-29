import { createHash } from "node:crypto";
import { DatabaseSync, backup } from "node:sqlite";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CURRENT_SCHEMA_VERSION = 1;

const LEGACY_DOCUMENTS = [
  { key: "manager", filename: "manager.json", version: 1 },
  { key: "runtime-state", filename: "runtime-state.json", version: 1 },
  { key: "users", filename: "users.json", version: 1 }
] as const;

/** Metadata attached to a recoverable manager configuration revision. */
export interface ConfigRevisionMetadata {
  actor: string;
  summary: string;
}

/** Public, non-secret details for one saved configuration revision. */
export interface ConfigRevisionSummary extends ConfigRevisionMetadata {
  id: number;
  createdAt: string;
}

interface PreparedLegacyDocument {
  key: string;
  filename: string;
  version: number;
  payload?: string;
  sha256?: string;
}

/**
 * Owns the manager's versioned SQLite file and the atomic persistence primitives
 * shared by configuration, runtime state, and authentication stores. Existing
 * JSON stores are imported once and kept as recovery copies. SQLite's WAL and
 * full synchronous mode protect committed updates across process restarts.
 */
export class SqliteStore {
  private readonly databasePath: string;
  private database?: DatabaseSync;

  /** Creates a database store at `manager.sqlite` under the persistent data path. */
  constructor(dataDirectory: string) {
    this.databasePath = path.join(dataDirectory, "manager.sqlite");
  }

  /** Opens the database, applies schema migrations, and imports legacy JSON once. */
  async initialize(): Promise<void> {
    if (this.database) return;
    await mkdir(path.dirname(this.databasePath), { recursive: true, mode: 0o700 });
    const database = new DatabaseSync(this.databasePath, { enableForeignKeyConstraints: true });
    this.database = database;
    await chmod(this.databasePath, 0o600);
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec("PRAGMA synchronous = FULL;");
    database.exec("PRAGMA busy_timeout = 5000;");
    this.applyMigrations(database);
    await this.protectSidecar(`${this.databasePath}-wal`);
    await this.protectSidecar(`${this.databasePath}-shm`);
    await this.importLegacyDocuments();
  }

  /** Returns the JSON text for a named store document, or undefined before first save. */
  readDocument(key: string): string | undefined {
    const row = this.getDatabase().prepare(
      "SELECT document_version, payload FROM store_documents WHERE key = ?"
    ).get(key) as { document_version: number; payload: string } | undefined;
    if (row && row.document_version !== 1) {
      throw new Error(`The saved '${key}' document uses unsupported version ${row.document_version}.`);
    }
    return row?.payload;
  }

  /** Atomically replaces one versioned JSON document in the database. */
  writeDocument(key: string, version: number, payload: string): void {
    this.writeDocumentRow(this.getDatabase(), key, version, payload);
  }

  /** Saves the encrypted manager configuration and records a revision in one transaction. */
  saveManagerConfig(payload: string, metadata: ConfigRevisionMetadata): void {
    const database = this.getDatabase();
    const hash = createHash("sha256").update(payload).digest("hex");
    // The initial document and its baseline revision must appear together or a restart could leave history incomplete.
    database.exec("BEGIN IMMEDIATE;");
    try {
      this.writeDocumentRow(database, "manager", 1, payload);
      const latest = database.prepare("SELECT config_hash FROM config_revisions ORDER BY id DESC LIMIT 1").get() as { config_hash: string } | undefined;
      if (latest?.config_hash !== hash) {
        database.prepare(
          "INSERT INTO config_revisions (created_at, actor, summary, config_hash, config_json) VALUES (?, ?, ?, ?, ?)"
        ).run(new Date().toISOString(), normalizeRevisionText(metadata.actor, "system"), normalizeRevisionText(metadata.summary, "Configuration updated"), hash, payload);
      }
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
  }

  /** Creates a recoverable baseline after initial import without duplicating existing history. */
  ensureInitialConfigRevision(payload: string): void {
    const database = this.getDatabase();
    const hash = createHash("sha256").update(payload).digest("hex");
    database.exec("BEGIN IMMEDIATE;");
    try {
      const existing = database.prepare("SELECT id FROM config_revisions LIMIT 1").get();
      if (!existing) {
        this.writeDocumentRow(database, "manager", 1, payload);
        database.prepare(
          "INSERT INTO config_revisions (created_at, actor, summary, config_hash, config_json) VALUES (?, ?, ?, ?, ?)"
        ).run(new Date().toISOString(), "system", "Initial configuration", hash, payload);
      }
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
  }

  /** Lists revisions newest first without exposing encrypted credentials or profile data. */
  listConfigRevisions(limit = 100): ConfigRevisionSummary[] {
    const boundedLimit = Math.min(500, Math.max(1, Math.trunc(limit)));
    const rows = this.getDatabase().prepare(
      "SELECT id, created_at, actor, summary FROM config_revisions ORDER BY id DESC LIMIT ?"
    ).all(boundedLimit) as Array<{ id: number; created_at: string; actor: string; summary: string }>;
    return rows.map((row) => ({ id: row.id, createdAt: row.created_at, actor: row.actor, summary: row.summary }));
  }

  /** Returns a stored encrypted manager-config revision for a privileged restore operation. */
  readConfigRevision(id: number): string | undefined {
    const row = this.getDatabase().prepare("SELECT config_json FROM config_revisions WHERE id = ?").get(id) as { config_json: string } | undefined;
    return row?.config_json;
  }

  /** Produces a transactionally consistent SQLite database image for ZIP backups. */
  async createBackupSnapshot(): Promise<Buffer> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "nspanel-sqlite-backup-"));
    const snapshotPath = path.join(directory, "manager.sqlite");
    try {
      await backup(this.getDatabase(), snapshotPath);
      return await readFile(snapshotPath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  /** Flushes WAL pages and closes the connection during graceful shutdown. */
  close(): void {
    if (!this.database) return;
    this.database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    this.database.close();
    this.database = undefined;
  }

  /** Applies each numbered schema migration once, keeping schema history in the database. */
  private applyMigrations(database: DatabaseSync): void {
    database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);");
    const newestApplied = database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number | null };
    if ((newestApplied.version ?? 0) > CURRENT_SCHEMA_VERSION) {
      throw new Error(`The manager database schema version ${newestApplied.version} is newer than this application supports (${CURRENT_SCHEMA_VERSION}).`);
    }
    const migrations: Array<{ version: number; sql: string }> = [
      {
        version: 1,
        sql: `
          CREATE TABLE store_documents (
            key TEXT PRIMARY KEY,
            document_version INTEGER NOT NULL,
            payload TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE legacy_imports (
            filename TEXT PRIMARY KEY,
            imported_at TEXT NOT NULL,
            result TEXT NOT NULL,
            source_sha256 TEXT
          );
          CREATE TABLE config_revisions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            actor TEXT NOT NULL,
            summary TEXT NOT NULL,
            config_hash TEXT NOT NULL,
            config_json TEXT NOT NULL
          );
          CREATE INDEX config_revisions_created_at_idx ON config_revisions(created_at DESC);
        `
      }
    ];
    const appliedVersions = new Set((database.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map((row) => row.version));
    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) continue;
      // Apply DDL and its version marker together so a restart cannot mistake a partial migration for a completed one.
      database.exec("BEGIN IMMEDIATE;");
      try {
        database.exec(migration.sql);
        database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(migration.version, new Date().toISOString());
        database.exec("COMMIT;");
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }
    }
  }

  /** Applies private file permissions to SQLite sidecars created for WAL mode. */
  private async protectSidecar(filePath: string): Promise<void> {
    try {
      await chmod(filePath, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  /** Copies pre-SQLite JSON files into empty document slots without deleting their originals. */
  private async importLegacyDocuments(): Promise<void> {
    const database = this.getDatabase();
    const prepared: PreparedLegacyDocument[] = [];
    for (const legacy of LEGACY_DOCUMENTS) {
      const imported = database.prepare("SELECT filename FROM legacy_imports WHERE filename = ?").get(legacy.filename);
      if (imported) continue;
      try {
        const payload = await readFile(path.join(path.dirname(this.databasePath), legacy.filename), "utf8");
        JSON.parse(payload);
        prepared.push({ ...legacy, payload, sha256: createHash("sha256").update(payload).digest("hex") });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          prepared.push({ ...legacy });
          continue;
        }
        if (error instanceof SyntaxError) {
          throw new Error(`Legacy data file '${legacy.filename}' is not valid JSON. It was left untouched; SQLite import stopped.`, { cause: error });
        }
        throw error;
      }
    }
    if (prepared.length === 0) return;

    database.exec("BEGIN IMMEDIATE;");
    try {
      const selectDocument = database.prepare("SELECT key FROM store_documents WHERE key = ?");
      const insertImport = database.prepare(
        "INSERT OR IGNORE INTO legacy_imports (filename, imported_at, result, source_sha256) VALUES (?, ?, ?, ?)"
      );
      for (const item of prepared) {
        const alreadyImported = database.prepare("SELECT filename FROM legacy_imports WHERE filename = ?").get(item.filename);
        if (alreadyImported) continue;
        const documentExists = selectDocument.get(item.key);
        if (item.payload !== undefined && !documentExists) this.writeDocumentRow(database, item.key, item.version, item.payload);
        const result = item.payload === undefined ? "missing" : documentExists ? "database-preserved" : "imported";
        insertImport.run(item.filename, new Date().toISOString(), result, item.sha256 ?? null);
      }
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
  }

  /** Writes or updates one JSON document using the caller's active transaction. */
  private writeDocumentRow(database: DatabaseSync, key: string, version: number, payload: string): void {
    database.prepare(`
      INSERT INTO store_documents (key, document_version, payload, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        document_version = excluded.document_version,
        payload = excluded.payload,
        updated_at = excluded.updated_at
    `).run(key, version, payload, new Date().toISOString());
  }

  /** Returns the active synchronous database connection or explains startup ordering. */
  private getDatabase(): DatabaseSync {
    if (!this.database) throw new Error("The SQLite store has not been initialized.");
    return this.database;
  }
}

/** Bounds revision metadata so malformed callers cannot grow the audit table without limit. */
function normalizeRevisionText(value: string, fallback: string): string {
  const normalized = value.trim().replace(/[\r\n\t]+/g, " ").slice(0, 200);
  return normalized || fallback;
}
