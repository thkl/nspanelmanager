import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Panel } from "../../types.js";

const MAX_DUMP_BYTES = 0x40000;
const MAX_CHUNK_BYTES = 300;
const DUMP_ID_PATTERN = /^[0-9a-f]{8}$/i;
const PANEL_ID_PATTERN = /^[0-9a-f-]{1,64}$/i;

export interface CoreDumpRecord {
  panelId: string;
  dumpId: string;
  firmwareVersion: string;
  sizeBytes: number;
  chunkCount: number;
  panicReason?: string;
  sha256: string;
  capturedAt: string;
  filename: string;
}

interface CoreDumpManifest {
  dumpId: string;
  firmwareVersion: string;
  sizeBytes: number;
  chunkSize: number;
  chunkCount: number;
  panicReason?: string;
}

interface ActiveTransfer {
  manifest: CoreDumpManifest;
  chunks: Array<Buffer | undefined>;
  receivedChunks: number;
}

/** Stores complete panel core dumps received as ordered MQTT chunks. */
export class CoreDumpStore {
  private readonly directory: string;
  private readonly indexPath: string;
  private readonly latestByPanel = new Map<string, CoreDumpRecord>();
  private readonly activeTransfers = new Map<string, ActiveTransfer>();
  private initialized = false;
  private pendingWrite: Promise<void> = Promise.resolve();

  /** Creates a private dump directory beneath the manager's persistent data path. */
  constructor(dataDirectory: string) {
    this.directory = path.join(path.resolve(dataDirectory), "crash-dumps");
    this.indexPath = path.join(this.directory, "index.json");
  }

  /** Loads the latest dump index and drops entries whose binary is missing. */
  async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directoryInfo = await lstat(this.directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error("The core dump path must be a real directory.");
    await chmod(this.directory, 0o700);

    try {
      const indexInfo = await lstat(this.indexPath);
      if (!indexInfo.isFile() || indexInfo.isSymbolicLink()) throw new Error("The core dump index must be a regular file.");
      const parsed = parseIndex(JSON.parse(await readFile(this.indexPath, "utf8")) as unknown);
      for (const record of parsed) {
        try {
          const filePath = this.filePath(record.filename);
          const fileInfo = await lstat(filePath);
          if (fileInfo.isFile() && !fileInfo.isSymbolicLink() && fileInfo.size === record.sizeBytes) {
            this.latestByPanel.set(record.panelId, record);
          }
        } catch (error) {
          if (!isMissingFile(error)) throw error;
        }
      }
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    this.initialized = true;
  }

  /** Processes a single dump manifest, data chunk, or completion message. */
  async receive(panel: Panel, topic: string, payload: string, receivedAt: number): Promise<string | undefined> {
    this.ensureInitialized();
    // Transfer messages are accepted only after the manifest establishes a bounded chunk plan.
    if (!PANEL_ID_PATTERN.test(panel.id)) return undefined;
    if (topic === "manifest") {
      this.begin(panel, payload);
      return undefined;
    }
    if (topic === "chunk") {
      this.addChunk(panel, payload);
      return undefined;
    }
    if (topic === "complete") return this.finish(panel, payload, receivedAt);
    return undefined;
  }

  /** Returns metadata for the most recently received dump from a configured panel. */
  latest(panelId: string): CoreDumpRecord | undefined {
    const record = this.latestByPanel.get(panelId);
    return record ? { ...record } : undefined;
  }

  /** Resolves a validated filename from the current panel dump index. */
  fileFor(panelId: string): { record: CoreDumpRecord; filePath: string } | undefined {
    const record = this.latestByPanel.get(panelId);
    if (!record) return undefined;
    return { record: { ...record }, filePath: this.filePath(record.filename) };
  }

  private begin(panel: Panel, payload: string): void {
    const parsed = parseManifest(payload);
    if (!parsed) throw new Error(`Rejected an invalid core dump manifest from ${panel.nodeName}.`);
    this.activeTransfers.set(panel.id, {
      manifest: parsed,
      chunks: new Array(parsed.chunkCount),
      receivedChunks: 0
    });
  }

  private addChunk(panel: Panel, payload: string): void {
    const value = parseObject(payload);
    if (!value || typeof value["dump_id"] !== "string" || !Number.isInteger(value["index"]) || typeof value["data"] !== "string") {
      throw new Error(`Rejected an invalid core dump chunk from ${panel.nodeName}.`);
    }
    const transfer = this.activeTransfers.get(panel.id);
    const index = value["index"] as number;
    if (!transfer || value["dump_id"] !== transfer.manifest.dumpId || index < 0 || index >= transfer.manifest.chunkCount) {
      throw new Error(`Ignored a core dump chunk outside the active transfer from ${panel.nodeName}.`);
    }

    const encoded = value["data"];
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new Error(`Rejected invalid base64 in a core dump chunk from ${panel.nodeName}.`);
    }
    const chunk = Buffer.from(encoded, "base64");
    const expectedLength = index + 1 === transfer.manifest.chunkCount
      ? transfer.manifest.sizeBytes - index * transfer.manifest.chunkSize
      : transfer.manifest.chunkSize;
    if (chunk.length !== expectedLength || chunk.length > MAX_CHUNK_BYTES) {
      throw new Error(`Rejected a core dump chunk with an unexpected size from ${panel.nodeName}.`);
    }

    const previous = transfer.chunks[index];
    if (previous) {
      if (!previous.equals(chunk)) throw new Error(`Rejected a conflicting duplicate core dump chunk from ${panel.nodeName}.`);
      return;
    }
    transfer.chunks[index] = chunk;
    transfer.receivedChunks += 1;
  }

  private async finish(panel: Panel, payload: string, receivedAt: number): Promise<string | undefined> {
    const value = parseObject(payload);
    if (!value || typeof value["dump_id"] !== "string") throw new Error(`Rejected an invalid core dump completion message from ${panel.nodeName}.`);
    const transfer = this.activeTransfers.get(panel.id);
    if (!transfer || value["dump_id"] !== transfer.manifest.dumpId) return undefined;
    if (transfer.receivedChunks !== transfer.manifest.chunkCount || transfer.chunks.some((chunk) => !chunk)) {
      throw new Error(`Core dump from ${panel.nodeName} ended with missing chunks.`);
    }

    const bytes = Buffer.concat(transfer.chunks as Buffer[], transfer.manifest.sizeBytes);
    if (bytes.length !== transfer.manifest.sizeBytes) throw new Error(`Core dump from ${panel.nodeName} has an invalid total size.`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const filename = `core-${panel.id}-${transfer.manifest.dumpId}.bin`;
    const temporaryPath = path.join(this.directory, `.${filename}.upload`);
    const destinationPath = this.filePath(filename);

    await writeFile(temporaryPath, bytes, { flag: "w", mode: 0o600 });
    await rename(temporaryPath, destinationPath);

    const record: CoreDumpRecord = {
      panelId: panel.id,
      dumpId: transfer.manifest.dumpId,
      firmwareVersion: transfer.manifest.firmwareVersion,
      sizeBytes: bytes.length,
      chunkCount: transfer.manifest.chunkCount,
      ...(transfer.manifest.panicReason ? { panicReason: transfer.manifest.panicReason } : {}),
      sha256,
      capturedAt: new Date(receivedAt).toISOString(),
      filename
    };
    const previous = this.latestByPanel.get(panel.id);
    this.latestByPanel.set(panel.id, record);
    await this.persistIndex();
    if (previous && previous.filename !== filename) await rm(this.filePath(previous.filename), { force: true });
    this.activeTransfers.delete(panel.id);
    return transfer.manifest.dumpId;
  }

  private async persistIndex(): Promise<void> {
    const operation = this.pendingWrite.then(async () => {
      const records = [...this.latestByPanel.values()];
      const temporaryPath = `${this.indexPath}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(records, null, 2), { flag: "w", mode: 0o600 });
      await rename(temporaryPath, this.indexPath);
    });
    this.pendingWrite = operation.catch(() => undefined);
    await operation;
  }

  private filePath(filename: string): string {
    if (!/^core-[0-9a-f-]{1,64}-[0-9a-f]{8}\.bin$/i.test(filename)) throw new Error("Invalid core dump filename.");
    return path.join(this.directory, filename);
  }

  private ensureInitialized(): void {
    if (!this.initialized) throw new Error("The core dump store has not been loaded.");
  }
}

function parseManifest(payload: string): CoreDumpManifest | undefined {
  const value = parseObject(payload);
  if (!value) return undefined;
  const dumpId = value["dump_id"];
  const firmwareVersion = value["firmware_version"];
  const sizeBytes = value["size_bytes"];
  const chunkSize = value["chunk_size"];
  const chunkCount = value["chunk_count"];
  const panicReason = value["panic_reason"];
  if (typeof dumpId !== "string" || !DUMP_ID_PATTERN.test(dumpId) ||
      typeof firmwareVersion !== "string" || firmwareVersion.length > 40 ||
      typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_DUMP_BYTES ||
      chunkSize !== MAX_CHUNK_BYTES || typeof chunkCount !== "number" || !Number.isSafeInteger(chunkCount) ||
      chunkCount !== Math.ceil(sizeBytes / chunkSize) || chunkCount > 900 ||
      panicReason !== undefined && typeof panicReason !== "string") return undefined;
  return { dumpId, firmwareVersion, sizeBytes, chunkSize, chunkCount, ...(panicReason ? { panicReason } : {}) };
}

function parseObject(payload: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(payload) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function parseIndex(value: unknown): CoreDumpRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isCoreDumpRecord);
}

function isCoreDumpRecord(value: unknown): value is CoreDumpRecord {
  if (!isRecord(value)) return false;
  return typeof value["panelId"] === "string" && PANEL_ID_PATTERN.test(value["panelId"]) &&
    typeof value["dumpId"] === "string" && DUMP_ID_PATTERN.test(value["dumpId"]) &&
    typeof value["firmwareVersion"] === "string" && typeof value["sizeBytes"] === "number" &&
    Number.isSafeInteger(value["sizeBytes"]) && value["sizeBytes"] > 0 && value["sizeBytes"] <= MAX_DUMP_BYTES &&
    typeof value["chunkCount"] === "number" && typeof value["sha256"] === "string" &&
    /^[0-9a-f]{64}$/.test(value["sha256"]) && typeof value["capturedAt"] === "string" &&
    typeof value["filename"] === "string" && /^core-[0-9a-f-]{1,64}-[0-9a-f]{8}\.bin$/i.test(value["filename"]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
