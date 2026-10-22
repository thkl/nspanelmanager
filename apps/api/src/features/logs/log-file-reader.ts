import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { LogLevel, LogRecord } from "../../services/logger.js";

const LOG_FILE_PATTERN = /^manager-\d{4}-\d{2}-\d{2}\.log(?:\.\d+)?$/;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_SCANNED_LINES = 20_000;

/** Log record enriched with the component category used by the administrator viewer. */
export interface AdminLogEntry extends LogRecord {
  category: string;
}

/** Bounded log query supported by the admin log endpoint. */
export interface LogQuery {
  limit: number;
  offset: number;
  category?: string;
  level?: LogLevel;
}

/** Recent log entries plus category choices observed during the bounded read. */
export interface LogQueryResult {
  logs: AdminLogEntry[];
  categories: string[];
  hasMore: boolean;
  scanLimitReached: boolean;
}

interface LogFile {
  filePath: string;
  modifiedAt: number;
}

/** Reads only application-owned rotated files and returns a bounded recent view. */
export class LogFileReader {
  private readonly directory: string;

  /** Binds the reader to the log directory selected at server startup. */
  constructor(directory: string) { this.directory = path.resolve(directory); }

  /** Reads matching records newest-first from disk, then returns them in display order. */
  async read(query: LogQuery): Promise<LogQueryResult> {
    const files = await this.listRotatedFiles();
    const newestFirst: AdminLogEntry[] = [];
    const categories = new Set<string>();
    const wantedMatches = query.offset + query.limit + 1;
    let scannedLines = 0;
    let scanLimitReached = false;

    for (const file of files) {
      try {
        await visitNewestLines(file.filePath, (line) => {
          if (scannedLines >= MAX_SCANNED_LINES) {
            scanLimitReached = true;
            return false;
          }
          scannedLines += 1;
          const record = parseRecord(line);
          if (!record) return scannedLines < MAX_SCANNED_LINES;

          const category = record.context.component?.trim() || "general";
          categories.add(category);
          if ((!query.category || query.category === category) && (!query.level || query.level === record.level)) {
            newestFirst.push({ ...record, category });
          }
          if (newestFirst.length >= wantedMatches) return false;
          if (scannedLines >= MAX_SCANNED_LINES) {
            scanLimitReached = true;
            return false;
          }
          return true;
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (newestFirst.length >= wantedMatches || scanLimitReached) break;
    }
    if (scannedLines >= MAX_SCANNED_LINES && newestFirst.length < wantedMatches) scanLimitReached = true;

    return {
      logs: newestFirst.slice(query.offset, query.offset + query.limit),
      categories: [...categories].sort((left, right) => left.localeCompare(right)),
      hasMore: newestFirst.length > query.offset + query.limit,
      scanLimitReached
    };
  }

  /** Lists only regular files created by the manager's rotating Winston transport. */
  private async listRotatedFiles(): Promise<LogFile[]> {
    let entries;
    try { entries = await readdir(this.directory, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const candidates = entries.filter((entry) => entry.isFile() && LOG_FILE_PATTERN.test(entry.name));
    const files = await Promise.all(candidates.map(async (entry) => {
      const filePath = path.join(this.directory, entry.name);
      try { return { filePath, modifiedAt: (await stat(filePath)).mtimeMs }; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    }));
    return files.filter((file): file is LogFile => Boolean(file)).sort((left, right) => right.modifiedAt - left.modifiedAt);
  }
}

/** Visits complete lines from the end of one file without loading the file into memory. */
async function visitNewestLines(filePath: string, visit: (line: string) => boolean): Promise<void> {
  const file = await open(filePath, "r");
  try {
    let position = (await file.stat()).size;
    let carry = "";
    while (position > 0) {
      const start = Math.max(0, position - READ_CHUNK_BYTES);
      const buffer = Buffer.allocUnsafe(position - start);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      if (bytesRead === 0) break;
      position = start;

      const lines = `${buffer.subarray(0, bytesRead).toString("utf8")}${carry}`.split("\n");
      carry = lines.shift() ?? "";
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index].replace(/\r$/, "");
        if (line && !visit(line)) return;
      }
    }
    if (position === 0 && carry && !visit(carry.replace(/\r$/, ""))) return;
  } finally {
    await file.close();
  }
}

/** Parses only the stable fields written by the manager logger and drops malformed lines. */
function parseRecord(line: string): LogRecord | undefined {
  let value: unknown;
  try { value = JSON.parse(line); }
  catch { return undefined; }
  if (!isRecord(value) || typeof value.timestamp !== "string" || typeof value.message !== "string" || !isLogLevel(value.level)) return undefined;

  const context: Record<string, string> = {};
  if (isRecord(value.context)) {
    for (const [key, item] of Object.entries(value.context)) {
      if (typeof item === "string") context[key] = item;
    }
  }
  return { timestamp: value.timestamp, level: value.level, message: value.message, context };
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function isLogLevel(value: unknown): value is LogLevel { return value === "debug" || value === "info" || value === "warn" || value === "error"; }
