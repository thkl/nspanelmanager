import { createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { ZipArchive } from "archiver";

interface BackupEntryBase {
  archivePath: string;
  date: Date;
  mode: number;
}

type BackupEntry =
  | (BackupEntryBase & { type: "directory" })
  | (BackupEntryBase & { absolutePath: string; type: "file" });

/**
 * Builds downloadable archives from the configured manager data directory.
 *
 * The archive is streamed to the HTTP response by the route, so no second copy
 * of the data is written to disk. Only regular files and real directories are
 * traversed; nested symbolic links are skipped to prevent reading outside the
 * configured data directory. File and directory modes are retained for manual
 * restore. The live SQLite file and WAL sidecars are replaced by a consistent
 * database snapshot, and the caller supplies a runtime-state flush so cached
 * script writes are included. Runtime secrets mounted separately from
 * `DATA_DIR` are outside this service's scope.
 */
export class BackupArchiveService {
  private readonly dataDirectory: string;
  private backupDirectory: string;
  private excludedBackupDirectory?: string;
  private initialization?: Promise<void>;

  /** Binds backup creation to durable data, runtime flushing, and a consistent SQLite snapshot. */
  constructor(
    dataDirectory: string,
    private readonly flushRuntimeState: () => Promise<void>,
    backupDirectory = "backups",
    private readonly createSqliteSnapshot?: () => Promise<Buffer>
  ) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.backupDirectory = this.resolveBackupDirectory(backupDirectory);
  }

  /** Creates and protects the archive directory, excluding it from future data archives when nested in DATA_DIR. */
  async initialize(): Promise<void> {
    this.initialization ??= this.prepareBackupDirectory(this.backupDirectory).then((directory) => {
      this.backupDirectory = directory;
    });
    await this.initialization;
  }

  /** Changes the scheduled-archive destination after ensuring it is writable and safe to use. */
  async setBackupDirectory(directory: string): Promise<void> {
    const nextDirectory = this.resolveBackupDirectory(directory);
    const preparedDirectory = await this.prepareBackupDirectory(nextDirectory);
    this.backupDirectory = preparedDirectory;
    this.initialization = Promise.resolve();
  }

  /** Flushes cached runtime values, then creates a ZIP rooted under `data/`. */
  async createArchive(): Promise<ZipArchive> {
    await this.initialize();
    await this.flushRuntimeState();
    const archive = new ZipArchive({ zlib: { level: 6 } });
    const rootPath = await realpath(this.dataDirectory);
    const rootMetadata = await lstat(rootPath);
    if (!rootMetadata.isDirectory()) throw new Error("The configured manager data path is not a directory.");
    archive.append(Buffer.alloc(0), { name: "data/", type: "directory", date: rootMetadata.mtime, mode: rootMetadata.mode });
    const archiveEntries = await this.listEntries(rootPath, this.excludedBackupDirectory);
    for (const entry of archiveEntries) {
      // SQLite WAL mode requires a coordinated backup image; never archive the live database file alongside it.
      if (entry.type === "file" && isLiveSqliteFile(rootPath, entry.absolutePath)) continue;
      if (entry.type === "directory") archive.append(Buffer.alloc(0), { name: entry.archivePath, type: "directory", date: entry.date, mode: entry.mode });
      else archive.file(entry.absolutePath, { name: entry.archivePath, date: entry.date, mode: entry.mode });
    }
    if (this.createSqliteSnapshot) {
      // The snapshot replaces the skipped live file so the ZIP contains one consistent database state.
      const snapshot = await this.createSqliteSnapshot();
      archive.append(snapshot, { name: "data/manager.sqlite", date: new Date(), mode: 0o600 });
    }
    return archive;
  }

  /** Writes a complete ZIP to the scheduled-backup directory and prunes older archives. */
  async createScheduledBackup(retentionCount: number): Promise<{ filename: string; sizeBytes: number }> {
    if (!Number.isSafeInteger(retentionCount) || retentionCount < 1) throw new Error("Backup retention must be a positive whole number.");
    await this.initialize();
    const filename = `nspanel-manager-data-${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}.zip`;
    const destination = path.join(this.backupDirectory, filename);
    const temporaryPath = path.join(this.backupDirectory, `.${filename}.${randomUUID()}.partial`);
    const archive = await this.createArchive();
    archive.on("warning", (error) => archive.emit("error", error));

    try {
      const write = pipeline(archive, createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }));
      await Promise.all([archive.finalize(), write]);
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, destination);
      await chmod(destination, 0o600);
      const metadata = await stat(destination);
      await this.pruneScheduledBackups(retentionCount);
      return { filename, sizeBytes: metadata.size };
    } catch (error) {
      archive.abort();
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** Lists directories and regular files recursively, skipping links and special files. */
  private async listEntries(rootPath: string, excludedDirectory?: string): Promise<BackupEntry[]> {
    const archiveEntries: BackupEntry[] = [];
    const directories = [""];

    while (directories.length > 0) {
      const relativeDirectory = directories.pop()!;
      const absoluteDirectory = path.join(rootPath, relativeDirectory);
      const directoryEntries = await readdir(absoluteDirectory, { withFileTypes: true });
      for (const directoryEntry of directoryEntries) {
        const relativePath = path.join(relativeDirectory, directoryEntry.name);
        const absolutePath = path.join(rootPath, relativePath);
        if (excludedDirectory && isPathWithin(excludedDirectory, absolutePath)) continue;
        const metadata = await lstat(absolutePath);
        const archivePath = `data/${relativePath.split(path.sep).join("/")}`;
        if (directoryEntry.isDirectory() && metadata.isDirectory() && !metadata.isSymbolicLink()) {
          archiveEntries.push({ archivePath: `${archivePath}/`, date: metadata.mtime, mode: metadata.mode, type: "directory" });
          directories.push(relativePath);
        } else if (directoryEntry.isFile() && metadata.isFile() && !metadata.isSymbolicLink()) {
          archiveEntries.push({ absolutePath, archivePath, date: metadata.mtime, mode: metadata.mode, type: "file" });
        }
      }
    }

    return archiveEntries.sort((left, right) => left.archivePath.localeCompare(right.archivePath));
  }

  private resolveBackupDirectory(directory: string): string {
    const value = directory.trim() || "backups";
    return path.isAbsolute(value) ? path.resolve(value) : path.resolve(this.dataDirectory, value);
  }

  private async prepareBackupDirectory(directory: string): Promise<string> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("The configured backup path must be a real directory.");
    const resolvedDirectory = await realpath(directory);

    const dataRoot = await realpath(this.dataDirectory);
    if (resolvedDirectory === dataRoot) throw new Error("The backup path cannot be the manager data directory itself.");
    await chmod(resolvedDirectory, 0o700);
    this.excludedBackupDirectory = isPathWithin(dataRoot, resolvedDirectory) ? resolvedDirectory : undefined;
    return resolvedDirectory;
  }

  private async pruneScheduledBackups(retentionCount: number): Promise<void> {
    const entries = await readdir(this.backupDirectory, { withFileTypes: true });
    const candidates = entries
      .filter((entry) => entry.isFile() && entry.name.startsWith("nspanel-manager-data-") && entry.name.endsWith(".zip"))
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left));
    for (const filename of candidates.slice(retentionCount)) {
      const filePath = path.join(this.backupDirectory, filename);
      const metadata = await lstat(filePath);
      if (metadata.isFile() && !metadata.isSymbolicLink()) await rm(filePath);
    }
  }
}

function isPathWithin(parentPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(parentPath, candidatePath);
  return relativePath === "" || relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath);
}

/** Excludes the live database and SQLite sidecars so backups contain one consistent image. */
function isLiveSqliteFile(rootPath: string, absolutePath: string): boolean {
  if (path.dirname(absolutePath) !== rootPath) return false;
  return ["manager.sqlite", "manager.sqlite-wal", "manager.sqlite-shm", "manager.sqlite-journal"].includes(path.basename(absolutePath));
}
