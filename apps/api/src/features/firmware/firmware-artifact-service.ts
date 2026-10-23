import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import type { FirmwareArtifactRecord } from "../../types.js";

export const MAX_FIRMWARE_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_FIRMWARE_UPLOAD_BYTES = MAX_FIRMWARE_FILE_BYTES + 64 * 1024;

const MAX_FIRMWARE_STORAGE_BYTES = 32 * 1024 * 1024;
const MAX_FIRMWARE_MANIFEST_BYTES = 16 * 1024;
const DOWNLOAD_GRANT_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_DOWNLOAD_GRANTS = 128;
const ARTIFACT_ID_PATTERN = /^[0-9a-f-]{36}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const FIRMWARE_VERSION_PATTERN = /^[0-9A-Za-z._+-]{1,40}$/;
const FIRMWARE_BUNDLE_FORMAT = "nspanel-unified-firmware";

interface DownloadGrant {
  tokenHash: string;
  artifactId: string;
  expiresAt: number;
}

interface FirmwareState {
  artifact: FirmwareArtifactRecord | null;
  grants: DownloadGrant[];
}

export interface FirmwareDownload {
  artifact: FirmwareArtifactRecord;
  filePath: string;
}

/** Indicates an invalid firmware upload or manager download URL setup error. */
export class FirmwareArtifactError extends Error {
  constructor(message: string, readonly statusCode: 400 | 404 | 409 | 503 = 400) {
    super(message);
    this.name = "FirmwareArtifactError";
  }
}

/** Persists firmware binaries and short-lived, single-artifact download grants for panels. */
export class FirmwareArtifactService {
  private readonly directory: string;
  private readonly statePath: string;
  private state: FirmwareState = { artifact: null, grants: [] };
  private initialized = false;
  private pendingOperation: Promise<void> = Promise.resolve();

  /** Places firmware uploads under manager data and builds URLs reachable from panels. */
  constructor(dataDirectory: string, private readonly publicUrl: string) {
    this.directory = path.join(path.resolve(dataDirectory), "firmware");
    this.statePath = path.join(this.directory, "state.json");
  }

  /** Loads persistent metadata and removes firmware files no longer referenced by links. */
  async load(): Promise<void> {
    await this.serialize(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const directoryMetadata = await lstat(this.directory);
      if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) throw new Error("The firmware storage path must be a real directory.");
      await chmod(this.directory, 0o700);
      try {
        const stateMetadata = await lstat(this.statePath);
        if (!stateMetadata.isFile() || stateMetadata.isSymbolicLink()) throw new Error("The firmware state path must be a regular file.");
        this.state = parseFirmwareState(JSON.parse(await readFile(this.statePath, "utf8")) as unknown);
      } catch (error) {
        if (!isMissingFile(error)) throw error;
        this.state = { artifact: null, grants: [] };
      }
      this.initialized = true;
      if (this.state.artifact && !(await this.isArtifactFileUsable(this.state.artifact.id, this.state.artifact.size))) {
        this.state = { ...this.state, artifact: null };
      }
      await this.pruneAndPersist();
    });
  }

  /** Returns metadata for the latest authenticated manager upload. */
  currentArtifact(): FirmwareArtifactRecord | null {
    return this.state.artifact ? { ...this.state.artifact } : null;
  }

  /** Extracts a versioned package or validates a raw ESP image, then atomically stores the binary. */
  async upload(bytes: Buffer, originalFilename: string, version: string): Promise<FirmwareArtifactRecord> {
    return this.serialize(async () => {
      this.ensureInitialized();
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new FirmwareArtifactError("Choose a non-empty firmware package to upload.");
      if (bytes.length > MAX_FIRMWARE_UPLOAD_BYTES) throw new FirmwareArtifactError("The firmware upload exceeds the 8 MB binary limit plus package overhead.");
      const uploadFilename = safeFilename(originalFilename);
      if (!uploadFilename) throw new FirmwareArtifactError("Choose a firmware package with a valid filename.");

      let firmwareBytes = bytes;
      let filename = uploadFilename;
      let firmwareVersion = version.trim();
      if (path.extname(uploadFilename).toLowerCase() === ".zip") {
        const bundle = extractFirmwareBundle(bytes);
        firmwareBytes = bundle.firmware;
        filename = bundle.filename;
        if (firmwareVersion && firmwareVersion !== bundle.version) {
          throw new FirmwareArtifactError("The supplied version does not match the version in the firmware manifest.");
        }
        firmwareVersion = bundle.version;
      } else if (path.extname(uploadFilename).toLowerCase() !== ".bin") {
        throw new FirmwareArtifactError("Upload a versioned firmware .zip package.");
      }

      if (firmwareBytes.length === 0 || firmwareBytes.length > MAX_FIRMWARE_FILE_BYTES) {
        throw new FirmwareArtifactError("The firmware binary must be non-empty and no larger than 8 MB.");
      }
      if (firmwareBytes[0] !== 0xe9) throw new FirmwareArtifactError("This does not look like an ESP32 OTA firmware image. Upload the ESPHome OTA image, not a factory or merged image.");
      if (!FIRMWARE_VERSION_PATTERN.test(firmwareVersion)) {
        throw new FirmwareArtifactError("A valid firmware version is required. Upload the versioned ZIP package or provide a version with a raw .bin file.");
      }
      if (path.extname(filename).toLowerCase() !== ".bin") throw new FirmwareArtifactError("The package must contain an ESPHome OTA .bin image.");

      await this.pruneAndPersist();
      if ((await this.storedArtifactBytes()) + firmwareBytes.length > MAX_FIRMWARE_STORAGE_BYTES) {
        throw new FirmwareArtifactError("Active panel download links are keeping older firmware files. Wait for those links to expire before uploading another binary.", 409);
      }

      const id = randomUUID();
      const temporaryPath = path.join(this.directory, `.${id}.upload`);
      const filePath = this.artifactPath(id);
      try {
        await writeFile(temporaryPath, firmwareBytes, { flag: "wx", mode: 0o600 });
        await rename(temporaryPath, filePath);
      } catch (error) {
        await rm(temporaryPath, { force: true });
        throw error;
      }

      const artifact: FirmwareArtifactRecord = {
        id,
        filename,
        version: firmwareVersion,
        size: firmwareBytes.length,
        md5: createHash("md5").update(firmwareBytes).digest("hex"),
        sha256: createHash("sha256").update(firmwareBytes).digest("hex"),
        uploadedAt: new Date().toISOString()
      };
      this.state = { ...this.state, artifact };
      await this.persistState();
      await this.pruneAndPersist();
      return { ...artifact };
    });
  }

  /** Creates a six-hour capability URL for the selected panel to download the binary. */
  async createDownloadUrl(): Promise<{ url: string; expiresAt: string; artifact: FirmwareArtifactRecord }> {
    return this.serialize(async () => {
      this.ensureInitialized();
      const artifact = this.state.artifact;
      if (!artifact) throw new FirmwareArtifactError("Upload a firmware binary before requesting a panel update.", 409);
      if (!(await this.isArtifactFileUsable(artifact.id, artifact.size))) {
        this.state = { ...this.state, artifact: null };
        await this.pruneAndPersist();
        throw new FirmwareArtifactError("The stored firmware file is unavailable. Upload it again before requesting an update.", 409);
      }
      const managerUrl = parsePublicUrl(this.publicUrl);
      const token = randomBytes(32).toString("base64url");
      const expiresAt = Date.now() + DOWNLOAD_GRANT_TTL_MS;
      const grant: DownloadGrant = {
        tokenHash: createHash("sha256").update(token).digest("hex"),
        artifactId: artifact.id,
        expiresAt
      };
      const activeGrants = this.state.grants.filter((item) => item.expiresAt > Date.now());
      if (activeGrants.length >= MAX_DOWNLOAD_GRANTS) activeGrants.sort((left, right) => right.expiresAt - left.expiresAt).pop();
      this.state = { ...this.state, grants: [...activeGrants, grant] };
      await this.pruneAndPersist();
      const url = new URL(`/api/firmware/download/${token}`, managerUrl);
      return { url: url.href, expiresAt: new Date(expiresAt).toISOString(), artifact: { ...artifact } };
    });
  }

  /** Resolves a valid grant without exposing storage paths to API callers. */
  async resolveDownload(token: string): Promise<FirmwareDownload | null> {
    return this.serialize(async () => {
      this.ensureInitialized();
      const now = Date.now();
      const grants = this.state.grants.filter((grant) => grant.expiresAt > now);
      const tokenHash = TOKEN_PATTERN.test(token) ? createHash("sha256").update(token).digest("hex") : "";
      const grant = tokenHash ? grants.find((item) => item.tokenHash === tokenHash) : undefined;
      if (grants.length !== this.state.grants.length) {
        this.state = { ...this.state, grants };
        await this.pruneAndPersist();
      }
      if (!grant) return null;
      const artifact = grant.artifactId === this.state.artifact?.id
        ? this.state.artifact
        : await this.readArtifactForGrant(grant.artifactId);
      if (!artifact) return null;
      const filePath = this.artifactPath(grant.artifactId);
      try {
        const metadata = await lstat(filePath);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== artifact.size) return null;
      } catch (error) {
        if (isMissingFile(error)) return null;
        throw error;
      }
      return { artifact: { ...artifact }, filePath };
    });
  }

  private async readArtifactForGrant(artifactId: string): Promise<FirmwareArtifactRecord | null> {
    if (!ARTIFACT_ID_PATTERN.test(artifactId)) return null;
    try {
      const metadata = await lstat(this.artifactPath(artifactId));
      if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
      return { id: artifactId, filename: "firmware.bin", version: "", size: metadata.size, md5: "", sha256: "", uploadedAt: metadata.mtime.toISOString() };
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  private async isArtifactFileUsable(artifactId: string, size: number): Promise<boolean> {
    try {
      const metadata = await lstat(this.artifactPath(artifactId));
      return metadata.isFile() && !metadata.isSymbolicLink() && metadata.size === size;
    } catch (error) {
      if (isMissingFile(error)) return false;
      throw error;
    }
  }

  private async storedArtifactBytes(): Promise<number> {
    const entries = await readdir(this.directory, { withFileTypes: true });
    const sizes = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".bin")).map(async (entry) => {
      const metadata = await lstat(path.join(this.directory, entry.name));
      return metadata.isFile() && !metadata.isSymbolicLink() ? metadata.size : 0;
    }));
    return sizes.reduce((total, size) => total + size, 0);
  }

  private async pruneAndPersist(): Promise<void> {
    const grants = this.state.grants.filter((grant) => grant.expiresAt > Date.now() && ARTIFACT_ID_PATTERN.test(grant.artifactId));
    this.state = { ...this.state, grants };
    await this.persistState();
    const referenced = new Set(grants.map((grant) => grant.artifactId));
    if (this.state.artifact) referenced.add(this.state.artifact.id);
    const entries = await readdir(this.directory, { withFileTypes: true });
    await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".bin"))
      .filter((entry) => !referenced.has(entry.name.slice(0, -4)))
      .map((entry) => rm(path.join(this.directory, entry.name), { force: true })));
  }

  private async persistState(): Promise<void> {
    const temporaryPath = path.join(this.directory, `.state-${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, JSON.stringify(this.state, null, 2), { flag: "wx", mode: 0o600 });
      await rename(temporaryPath, this.statePath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  private artifactPath(id: string): string {
    if (!ARTIFACT_ID_PATTERN.test(id)) throw new FirmwareArtifactError("The firmware artifact identifier is invalid.", 404);
    return path.join(this.directory, `${id}.bin`);
  }

  private ensureInitialized(): void {
    if (!this.initialized) throw new Error("Firmware artifact storage has not been loaded.");
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pendingOperation.then(operation, operation);
    this.pendingOperation = result.then(() => undefined, () => undefined);
    return result;
  }
}

interface FirmwareZipEntry {
  name: string;
  flags: number;
  method: number;
  checksum: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/** Reads the manager's two-file package without extracting user-controlled paths to disk. */
function extractFirmwareBundle(bytes: Buffer): { filename: string; version: string; firmware: Buffer } {
  const endOffset = findZipEndRecord(bytes);
  if (endOffset < 0) throw new FirmwareArtifactError("The ZIP package is incomplete or invalid.");
  const disk = bytes.readUInt16LE(endOffset + 4);
  const centralDisk = bytes.readUInt16LE(endOffset + 6);
  const diskEntryCount = bytes.readUInt16LE(endOffset + 8);
  const entryCount = bytes.readUInt16LE(endOffset + 10);
  const centralSize = bytes.readUInt32LE(endOffset + 12);
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  const commentLength = bytes.readUInt16LE(endOffset + 20);
  if (disk !== 0 || centralDisk !== 0 || diskEntryCount !== entryCount || entryCount !== 2
    || centralSize === 0xffffffff || centralOffset === 0xffffffff
    || endOffset + 22 + commentLength !== bytes.length || centralOffset + centralSize !== endOffset) {
    throw new FirmwareArtifactError("The ZIP package must contain exactly a manifest and one firmware image.");
  }

  const entries: FirmwareZipEntry[] = [];
  const names = new Set<string>();
  let cursor = centralOffset;
  const centralEnd = centralOffset + centralSize;
  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > centralEnd || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      throw new FirmwareArtifactError("The ZIP package has an invalid central directory.");
    }
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const checksum = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const entryCommentLength = bytes.readUInt16LE(cursor + 32);
    const startDisk = bytes.readUInt16LE(cursor + 34);
    const localHeaderOffset = bytes.readUInt32LE(cursor + 42);
    const entryEnd = cursor + 46 + nameLength + extraLength + entryCommentLength;
    if (entryEnd > centralEnd || !nameLength || startDisk !== 0 || compressedSize === 0xffffffff
      || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff || (flags & 0x41) !== 0
      || (method !== 0 && method !== 8)) {
      throw new FirmwareArtifactError("The ZIP package contains an unsupported or invalid entry.");
    }
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = nameBytes.toString("utf8");
    if (!Buffer.from(name, "utf8").equals(nameBytes) || !/^[A-Za-z0-9._-]+$/.test(name) || names.has(name)) {
      throw new FirmwareArtifactError("The ZIP package contains an invalid or duplicate filename.");
    }
    names.add(name);
    entries.push({ name, flags, method, checksum, compressedSize, uncompressedSize, localHeaderOffset });
    cursor = entryEnd;
  }
  if (cursor !== centralEnd || !names.has("manifest.json")) {
    throw new FirmwareArtifactError("The ZIP package must include a root-level manifest.json file.");
  }

  const manifestEntry = entries.find((entry) => entry.name === "manifest.json")!;
  if (manifestEntry.uncompressedSize > MAX_FIRMWARE_MANIFEST_BYTES) {
    throw new FirmwareArtifactError("The firmware manifest is too large.");
  }
  const manifestBytes = inflateZipEntry(bytes, manifestEntry, centralOffset);
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8")) as unknown;
  } catch {
    throw new FirmwareArtifactError("The firmware manifest is not valid JSON.");
  }
  if (!isRecord(manifest) || manifest["format"] !== FIRMWARE_BUNDLE_FORMAT || manifest["format_version"] !== 1
    || typeof manifest["version"] !== "string" || !FIRMWARE_VERSION_PATTERN.test(manifest["version"])
    || typeof manifest["firmware"] !== "string" || !/^[A-Za-z0-9._-]+\.bin$/i.test(manifest["firmware"])
    || typeof manifest["sha256"] !== "string" || !/^[0-9a-f]{64}$/.test(manifest["sha256"])) {
    throw new FirmwareArtifactError("The firmware manifest is missing a supported version, filename, or checksum.");
  }

  const firmwareEntry = entries.find((entry) => entry.name === manifest["firmware"]);
  if (!firmwareEntry || firmwareEntry.name === "manifest.json" || firmwareEntry.uncompressedSize === 0
    || firmwareEntry.uncompressedSize > MAX_FIRMWARE_FILE_BYTES) {
    throw new FirmwareArtifactError("The manifest must reference one non-empty firmware .bin file no larger than 8 MB.");
  }
  const firmware = inflateZipEntry(bytes, firmwareEntry, centralOffset);
  const digest = createHash("sha256").update(firmware).digest("hex");
  if (digest !== manifest["sha256"]) throw new FirmwareArtifactError("The firmware binary checksum does not match its manifest.");
  return { filename: firmwareEntry.name, version: manifest["version"], firmware };
}

function findZipEndRecord(bytes: Buffer): number {
  if (bytes.length < 22) return -1;
  const firstCandidate = Math.max(0, bytes.length - 22 - 0xffff);
  for (let offset = bytes.length - 22; offset >= firstCandidate; offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function inflateZipEntry(bytes: Buffer, entry: FirmwareZipEntry, centralOffset: number): Buffer {
  const offset = entry.localHeaderOffset;
  if (offset + 30 > centralOffset || bytes.readUInt32LE(offset) !== 0x04034b50) {
    throw new FirmwareArtifactError("The ZIP package contains an invalid local file header.");
  }
  const localFlags = bytes.readUInt16LE(offset + 6);
  const localMethod = bytes.readUInt16LE(offset + 8);
  const nameLength = bytes.readUInt16LE(offset + 26);
  const extraLength = bytes.readUInt16LE(offset + 28);
  const nameStart = offset + 30;
  const dataStart = nameStart + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  const localName = bytes.subarray(nameStart, nameStart + nameLength).toString("utf8");
  if ((localFlags & 0x41) !== 0 || localMethod !== entry.method || localName !== entry.name
    || dataStart > centralOffset || dataEnd > centralOffset) {
    throw new FirmwareArtifactError("The ZIP package entry does not match its directory record.");
  }
  const compressed = bytes.subarray(dataStart, dataEnd);
  let result: Buffer;
  try {
    result = entry.method === 0
      ? Buffer.from(compressed)
      : inflateRawSync(compressed, { maxOutputLength: entry.uncompressedSize });
  } catch {
    throw new FirmwareArtifactError(`The ZIP package entry '${entry.name}' could not be decompressed.`);
  }
  if (result.length !== entry.uncompressedSize || crc32(result) !== entry.checksum) {
    throw new FirmwareArtifactError(`The ZIP package entry '${entry.name}' failed its size or CRC check.`);
  }
  return result;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function parseFirmwareState(value: unknown): FirmwareState {
  if (!isRecord(value)) throw new Error("Stored firmware metadata is invalid.");
  const artifact = parseArtifact(value["artifact"]);
  const grants = Array.isArray(value["grants"]) ? value["grants"].flatMap((item): DownloadGrant[] => {
    if (!isRecord(item) || typeof item["tokenHash"] !== "string" || !/^[0-9a-f]{64}$/.test(item["tokenHash"])
      || typeof item["artifactId"] !== "string" || !ARTIFACT_ID_PATTERN.test(item["artifactId"])
      || typeof item["expiresAt"] !== "number" || !Number.isSafeInteger(item["expiresAt"])) return [];
    return [{ tokenHash: item["tokenHash"], artifactId: item["artifactId"], expiresAt: item["expiresAt"] }];
  }) : [];
  return { artifact, grants };
}

function parseArtifact(value: unknown): FirmwareArtifactRecord | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)
    || typeof value["id"] !== "string" || !ARTIFACT_ID_PATTERN.test(value["id"])
    || typeof value["filename"] !== "string" || !value["filename"].toLowerCase().endsWith(".bin")
    || typeof value["version"] !== "string" || !FIRMWARE_VERSION_PATTERN.test(value["version"])
    || typeof value["size"] !== "number" || !Number.isSafeInteger(value["size"]) || value["size"] < 1 || value["size"] > MAX_FIRMWARE_FILE_BYTES
    || typeof value["md5"] !== "string" || !/^[0-9a-f]{32}$/.test(value["md5"])
    || typeof value["sha256"] !== "string" || !/^[0-9a-f]{64}$/.test(value["sha256"])
    || typeof value["uploadedAt"] !== "string" || !Number.isFinite(Date.parse(value["uploadedAt"]))) throw new Error("Stored firmware artifact metadata is invalid.");
  return { id: value["id"], filename: safeFilename(value["filename"]), version: value["version"], size: value["size"], md5: value["md5"], sha256: value["sha256"], uploadedAt: value["uploadedAt"] };
}

function safeFilename(value: string): string {
  const basename = path.basename(value.trim()).replace(/[\u0000-\u001f\u007f"\\]/g, "_").slice(0, 120);
  return basename && basename !== "." ? basename : "";
}

function parsePublicUrl(value: string): URL {
  if (!value) throw new FirmwareArtifactError("Set APP_PUBLIC_URL or HMI_PUBLIC_URL to an address reachable from the panel.", 503);
  try {
    const url = new URL(value);
    if (!(url.protocol === "http:" || url.protocol === "https:") || url.username || url.password || url.search || url.hash) throw new Error("invalid");
    return url;
  } catch {
    throw new FirmwareArtifactError("APP_PUBLIC_URL or HMI_PUBLIC_URL must be a valid HTTP or HTTPS manager address reachable from the panel.", 503);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
