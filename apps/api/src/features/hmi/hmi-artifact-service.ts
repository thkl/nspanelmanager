import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HmiArtifactRecord } from "../../types.js";

export const MAX_HMI_FILE_BYTES = 32 * 1024 * 1024;

const MAX_HMI_STORAGE_BYTES = 128 * 1024 * 1024;
const DOWNLOAD_GRANT_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_DOWNLOAD_GRANTS = 128;
const ARTIFACT_ID_PATTERN = /^[0-9a-f-]{36}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

interface DownloadGrant {
  tokenHash: string;
  artifactId: string;
  expiresAt: number;
}

interface HmiState {
  artifact: HmiArtifactRecord | null;
  grants: DownloadGrant[];
}

export interface HmiDownload {
  artifact: HmiArtifactRecord;
  filePath: string;
}

/** Indicates an invalid upload or an HMI download URL setup error. */
export class HmiArtifactError extends Error {
  constructor(message: string, readonly statusCode: 400 | 404 | 409 | 503 = 400) {
    super(message);
    this.name = "HmiArtifactError";
  }
}

/**
 * Stores the latest uploaded Nextion TFT and temporary panel download grants.
 *
 * Artifact metadata and hashed grant tokens are persisted under `DATA_DIR/hmi`
 * so a manager restart does not invalidate an update already waiting on the
 * panel. The panel receives the raw random token only in its MQTT command.
 */
export class HmiArtifactService {
  private readonly directory: string;
  private readonly statePath: string;
  private readonly publicUrl: string;
  private state: HmiState = { artifact: null, grants: [] };
  private initialized = false;
  private pendingOperation: Promise<void> = Promise.resolve();

  /** Binds HMI files to durable manager data and the URL panels use to reach the manager. */
  constructor(dataDirectory: string, publicUrl: string) {
    this.directory = path.join(path.resolve(dataDirectory), "hmi");
    this.statePath = path.join(this.directory, "state.json");
    this.publicUrl = publicUrl.trim();
  }

  /** Loads saved metadata, expires old grants, and removes unreferenced HMI files. */
  async load(): Promise<void> {
    await this.serialize(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const directoryMetadata = await lstat(this.directory);
      if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) throw new Error("The HMI storage path must be a real directory.");
      await chmod(this.directory, 0o700);
      try {
        const stateMetadata = await lstat(this.statePath);
        if (!stateMetadata.isFile() || stateMetadata.isSymbolicLink()) throw new Error("The HMI state path must be a regular file.");
        const raw = await readFile(this.statePath, "utf8");
        this.state = parseHmiState(JSON.parse(raw) as unknown);
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

  /** Returns a copy of the latest uploaded HMI metadata for the authenticated UI. */
  currentArtifact(): HmiArtifactRecord | null {
    return this.state.artifact ? { ...this.state.artifact } : null;
  }

  /** Validates and atomically saves a `.tft` upload as the latest HMI artifact. */
  async upload(bytes: Buffer, originalFilename: string): Promise<HmiArtifactRecord> {
    return this.serialize(async () => {
      this.ensureInitialized();
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new HmiArtifactError("Choose a non-empty TFT file to upload.");
      if (bytes.length > MAX_HMI_FILE_BYTES) throw new HmiArtifactError("The TFT file exceeds the 32 MB upload limit.");
      const filename = safeFilename(originalFilename);
      if (!filename || path.extname(filename).toLowerCase() !== ".tft") throw new HmiArtifactError("Upload a file with the .tft extension.");
      await this.pruneAndPersist();
      if ((await this.storedArtifactBytes()) + bytes.length > MAX_HMI_STORAGE_BYTES) {
        throw new HmiArtifactError("Active panel download links are keeping older HMI files. Wait for those links to expire before uploading more files.", 409);
      }

      const id = randomUUID();
      const temporaryPath = path.join(this.directory, `.${id}.upload`);
      const filePath = this.artifactPath(id);
      try {
        await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
        await rename(temporaryPath, filePath);
      } catch (error) {
        await rm(temporaryPath, { force: true });
        throw error;
      }

      const artifact: HmiArtifactRecord = {
        id,
        filename,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        uploadedAt: new Date().toISOString()
      };
      this.state = { ...this.state, artifact };
      await this.persistState();
      await this.pruneAndPersist();
      return { ...artifact };
    });
  }

  /** Creates a six-hour capability URL that the selected panel can fetch without a browser session. */
  async createDownloadUrl(): Promise<{ url: string; expiresAt: string; artifact: HmiArtifactRecord }> {
    return this.serialize(async () => {
      this.ensureInitialized();
      const artifact = this.state.artifact;
      if (!artifact) throw new HmiArtifactError("Upload an HMI file before requesting a panel update.", 409);
      if (!(await this.isArtifactFileUsable(artifact.id, artifact.size))) {
        this.state = { ...this.state, artifact: null };
        await this.pruneAndPersist();
        throw new HmiArtifactError("The stored HMI file is unavailable. Upload it again before requesting an update.", 409);
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
      const url = new URL(`/api/hmi/download/${token}`, managerUrl);
      return { url: url.href, expiresAt: new Date(expiresAt).toISOString(), artifact: { ...artifact } };
    });
  }

  /** Resolves an unexpired token to its saved artifact without exposing filesystem paths to callers. */
  async resolveDownload(token: string): Promise<HmiDownload | null> {
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

  private async readArtifactForGrant(artifactId: string): Promise<HmiArtifactRecord | null> {
    if (!ARTIFACT_ID_PATTERN.test(artifactId)) return null;
    const filePath = this.artifactPath(artifactId);
    try {
      const metadata = await lstat(filePath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
      return {
        id: artifactId,
        filename: "hmi.tft",
        size: metadata.size,
        sha256: "",
        uploadedAt: metadata.mtime.toISOString()
      };
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
    const sizes = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".tft")).map(async (entry) => {
      const metadata = await lstat(path.join(this.directory, entry.name));
      return metadata.isFile() && !metadata.isSymbolicLink() ? metadata.size : 0;
    }));
    return sizes.reduce((total, size) => total + size, 0);
  }

  private async pruneAndPersist(): Promise<void> {
    const now = Date.now();
    const grants = this.state.grants.filter((grant) => grant.expiresAt > now && ARTIFACT_ID_PATTERN.test(grant.artifactId));
    this.state = { ...this.state, grants };
    await this.persistState();
    const referencedArtifacts = new Set(grants.map((grant) => grant.artifactId));
    if (this.state.artifact) referencedArtifacts.add(this.state.artifact.id);
    const entries = await readdir(this.directory, { withFileTypes: true });
    await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".tft"))
      .filter((entry) => !referencedArtifacts.has(entry.name.slice(0, -4)))
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
    if (!ARTIFACT_ID_PATTERN.test(id)) throw new HmiArtifactError("The HMI artifact identifier is invalid.", 404);
    return path.join(this.directory, `${id}.tft`);
  }

  private ensureInitialized(): void {
    if (!this.initialized) throw new Error("HMI artifact storage has not been loaded.");
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pendingOperation.then(operation, operation);
    this.pendingOperation = result.then(() => undefined, () => undefined);
    return result;
  }
}

function parseHmiState(value: unknown): HmiState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Stored HMI metadata is invalid.");
  const record = value as Record<string, unknown>;
  const artifact = parseArtifact(record["artifact"]);
  const grants = Array.isArray(record["grants"]) ? record["grants"].flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const grant = item as Record<string, unknown>;
    if (typeof grant["tokenHash"] !== "string" || !/^[0-9a-f]{64}$/.test(grant["tokenHash"])) return [];
    if (typeof grant["artifactId"] !== "string" || !ARTIFACT_ID_PATTERN.test(grant["artifactId"])) return [];
    if (typeof grant["expiresAt"] !== "number" || !Number.isSafeInteger(grant["expiresAt"])) return [];
    return [{ tokenHash: grant["tokenHash"], artifactId: grant["artifactId"], expiresAt: grant["expiresAt"] }];
  }) : [];
  return { artifact, grants };
}

function parseArtifact(value: unknown): HmiArtifactRecord | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Stored HMI artifact metadata is invalid.");
  const artifact = value as Record<string, unknown>;
  if (typeof artifact["id"] !== "string" || !ARTIFACT_ID_PATTERN.test(artifact["id"])) throw new Error("Stored HMI artifact identifier is invalid.");
  if (typeof artifact["filename"] !== "string" || !artifact["filename"].toLowerCase().endsWith(".tft")) throw new Error("Stored HMI artifact filename is invalid.");
  if (typeof artifact["size"] !== "number" || !Number.isSafeInteger(artifact["size"]) || artifact["size"] < 1 || artifact["size"] > MAX_HMI_FILE_BYTES) throw new Error("Stored HMI artifact size is invalid.");
  if (typeof artifact["sha256"] !== "string" || !/^[0-9a-f]{64}$/.test(artifact["sha256"])) throw new Error("Stored HMI artifact checksum is invalid.");
  if (typeof artifact["uploadedAt"] !== "string" || !Number.isFinite(Date.parse(artifact["uploadedAt"]))) throw new Error("Stored HMI artifact timestamp is invalid.");
  return {
    id: artifact["id"],
    filename: safeFilename(artifact["filename"]),
    size: artifact["size"],
    sha256: artifact["sha256"],
    uploadedAt: artifact["uploadedAt"]
  };
}

function safeFilename(value: string): string {
  const basename = path.basename(value.trim()).replace(/[\u0000-\u001f\u007f"\\]/g, "_").slice(0, 120);
  return basename && basename !== "." ? basename : "";
}

function parsePublicUrl(value: string): URL {
  if (!value) throw new HmiArtifactError("Set HMI_PUBLIC_URL or APP_PUBLIC_URL to an address reachable from the panel.", 503);
  try {
    const url = new URL(value);
    if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password || url.search || url.hash) throw new Error("invalid");
    return url;
  } catch {
    throw new HmiArtifactError("HMI_PUBLIC_URL must be a valid HTTP or HTTPS manager address reachable from the panel.", 503);
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
