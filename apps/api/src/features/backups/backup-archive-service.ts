import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
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
 * restore. Runtime secrets mounted separately from `DATA_DIR` are outside this
 * service's scope. The caller supplies a runtime-state flush so cached script
 * writes are included.
 */
export class BackupArchiveService {
  private readonly dataDirectory: string;

  /** Binds backup creation to the startup data path and durable runtime-state flush. */
  constructor(dataDirectory: string, private readonly flushRuntimeState: () => Promise<void>) {
    this.dataDirectory = path.resolve(dataDirectory);
  }

  /** Flushes cached runtime values, then creates a ZIP rooted under `data/`. */
  async createArchive(): Promise<ZipArchive> {
    await this.flushRuntimeState();
    const archive = new ZipArchive({ zlib: { level: 6 } });
    const rootPath = await realpath(this.dataDirectory);
    const rootMetadata = await lstat(rootPath);
    if (!rootMetadata.isDirectory()) throw new Error("The configured manager data path is not a directory.");
    archive.append(Buffer.alloc(0), { name: "data/", type: "directory", date: rootMetadata.mtime, mode: rootMetadata.mode });
    const archiveEntries = await this.listEntries(rootPath);
    for (const entry of archiveEntries) {
      if (entry.type === "directory") archive.append(Buffer.alloc(0), { name: entry.archivePath, type: "directory", date: entry.date, mode: entry.mode });
      else archive.file(entry.absolutePath, { name: entry.archivePath, date: entry.date, mode: entry.mode });
    }
    return archive;
  }

  /** Lists directories and regular files recursively, skipping links and special files. */
  private async listEntries(rootPath: string): Promise<BackupEntry[]> {
    const archiveEntries: BackupEntry[] = [];
    const directories = [""];

    while (directories.length > 0) {
      const relativeDirectory = directories.pop()!;
      const absoluteDirectory = path.join(rootPath, relativeDirectory);
      const directoryEntries = await readdir(absoluteDirectory, { withFileTypes: true });
      for (const directoryEntry of directoryEntries) {
        const relativePath = path.join(relativeDirectory, directoryEntry.name);
        const absolutePath = path.join(rootPath, relativePath);
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
}
