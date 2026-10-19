import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PluginState, PluginStorageScope } from "../plugins/plugin-contract.js";
import type { Logger } from "../../services/logger.js";

const MIN_PERSIST_INTERVAL_MS = 1_000;
const MAX_STORAGE_KEY_LENGTH = 256;
const MAX_STORAGE_VALUE_BYTES = 64 * 1024;
const MAX_STORAGE_ENTRIES = 4_096;
const MAX_STORAGE_BYTES = 2 * 1024 * 1024;

/** Persistent navigation context for an interactive plugin on one panel. */
export interface PanelFlowSession {
  bindingId: string;
  pluginInstanceId: string;
  /** Undefined while the panel is showing a firmware-managed page. */
  screen?: string;
  /** Marks a visible firmware-native Favorites menu while its script screen is unset. */
  menuPageActive?: boolean;
  /** Firmware page currently owned by a favorite flow after navigation leaves its script screen. */
  favoritePanelPage?: "level";
  /** Parent pages used to implement the firmware Back action for nested pages. */
  history?: string[];
  /** Synthetic binding used when a menu opens a plugin instance not directly bound to a favorite. */
  flowBinding?: import("../../types.js").PanelBinding;
  /** Plugin flow destinations to restore when the current child flow is exited. */
  ancestors?: PanelFlowFrame[];
}

/** One saved parent destination for a menu-launched plugin flow. */
export interface PanelFlowFrame {
  bindingId: string;
  pluginInstanceId: string;
  screen?: string;
  /** Restores a menu page after returning from a nested plugin flow. */
  menuPageActive?: boolean;
  /** Firmware page to reopen when restoring a native favorite-flow parent. */
  favoritePanelPage?: "level";
  history?: string[];
  flowBinding?: import("../../types.js").PanelBinding;
}

interface RuntimeSnapshot {
  version: 1;
  panelSessions: Record<string, PanelFlowSession>;
  values: Record<string, unknown>;
}

/**
 * Keeps normalized plugin message state in memory and persists panel flow
 * sessions plus explicitly saved script values. MQTT messages alone do not
 * write runtime snapshots; scripts opt into durable writes through storage APIs.
 * Changes are available in memory immediately and coalesced to a maximum of one
 * snapshot write per second. Script storage is limited to 4,096 values, 2 MiB
 * total, and 64 KiB per value. Call {@link flush} during graceful shutdown.
 */
export class RuntimeStateStore {
  private readonly filePath: string;
  private snapshot: RuntimeSnapshot = emptySnapshot();
  private readonly pluginStates: Record<string, PluginState> = {};
  private storageBytes = 0;
  private dirty = false;
  private writeTimer?: ReturnType<typeof setTimeout>;
  private activeWrite?: Promise<void>;
  private lastWriteAttemptAt = 0;
  private writeFailureReported = false;

  /** Creates the runtime store under the manager's durable data directory. */
  constructor(dataDir: string, private readonly logger?: Logger) { this.filePath = path.join(dataDir, "runtime-state.json"); }

  /** Loads durable flow and script values, removing legacy on-disk plugin message state. */
  async load(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    let serialized: string;
    try {
      serialized = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.persist();
        await this.flush();
        return;
      }
      throw error;
    }
    const value: unknown = JSON.parse(serialized);
    if (!isRecord(value)) throw new Error("The runtime state file is invalid; refusing to replace it.");
    const hadPersistedPluginStates = Object.hasOwn(value, "pluginStates");
    this.snapshot = {
      version: 1,
      panelSessions: isRecord(value.panelSessions) ? value.panelSessions as Record<string, PanelFlowSession> : {},
      values: isRecord(value.values) ? value.values : {}
    };
    this.storageBytes = measureStorageBytes(this.snapshot.values);
    if (hadPersistedPluginStates) {
      this.persist();
      await this.flush();
    }
  }

  /** Returns a defensive copy of one plugin instance's current in-memory state. */
  getPluginState(instanceId: string): PluginState { return structuredClone(this.pluginStates[instanceId] ?? {}); }

  /** Updates in-memory plugin state without serializing or writing the runtime snapshot. */
  async setPluginState(instanceId: string, state: PluginState): Promise<void> {
    this.pluginStates[instanceId] = structuredClone(state);
  }

  /** Removes in-memory device state, active flow context, and scoped values when an instance is deleted. */
  async removePluginInstance(instanceId: string): Promise<void> {
    delete this.pluginStates[instanceId];
    for (const [panelId, session] of Object.entries(this.snapshot.panelSessions)) {
      if (session.pluginInstanceId === instanceId) delete this.snapshot.panelSessions[panelId];
    }
    for (const key of Object.keys(this.snapshot.values)) {
      if (key.startsWith(`plugin:${instanceId}:`)) this.deleteStoredValue(key);
    }
    this.persist();
  }

  /** Returns a defensive copy of one panel's current interactive screen context. */
  getPanelSession(panelId: string): PanelFlowSession | undefined {
    const session = this.snapshot.panelSessions[panelId];
    return session ? structuredClone(session) : undefined;
  }

  /** Persists or clears the active flow context for a panel. */
  async setPanelSession(panelId: string, session?: PanelFlowSession): Promise<void> {
    if (session) this.snapshot.panelSessions[panelId] = structuredClone(session);
    else delete this.snapshot.panelSessions[panelId];
    this.persist();
  }

  /** Removes one panel's restored flow state when its saved profile is deleted. */
  async removePanel(panelId: string): Promise<void> {
    delete this.snapshot.panelSessions[panelId];
    for (const key of Object.keys(this.snapshot.values)) {
      if (key.startsWith(`panel:${panelId}:`)) this.deleteStoredValue(key);
    }
    this.persist();
  }

  /** Reads an arbitrary namespaced value for global, plugin, or panel flow storage. */
  getValue(scope: PluginStorageScope, ownerId: string, key: string): unknown {
    const value = this.snapshot.values[storageKey(scope, ownerId, key)];
    return value === undefined ? undefined : structuredClone(value);
  }

  /** Returns a defensive snapshot of every value in one script storage scope. */
  getScopeValues(scope: PluginStorageScope, ownerId: string): Record<string, unknown> {
    const prefix = `${scope}:${ownerId}:`;
    return Object.fromEntries(Object.entries(this.snapshot.values)
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => [key.slice(prefix.length), structuredClone(value)]));
  }

  /**
   * Saves a bounded namespaced value in memory immediately and schedules its
   * durable snapshot. The returned promise does not wait for the batched disk
   * write; use {@link flush} when the process is shutting down cleanly.
   */
  async setValue(scope: PluginStorageScope, ownerId: string, key: string, value: unknown): Promise<void> {
    if (key.length > MAX_STORAGE_KEY_LENGTH) throw new Error(`Storage keys may contain at most ${MAX_STORAGE_KEY_LENGTH} characters.`);
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("Storage values must be JSON serializable.");
    const valueBytes = Buffer.byteLength(serialized, "utf8");
    if (valueBytes > MAX_STORAGE_VALUE_BYTES) throw new Error(`Storage values may contain at most ${MAX_STORAGE_VALUE_BYTES} bytes.`);

    const scopedKey = storageKey(scope, ownerId, key);
    const existing = this.snapshot.values[scopedKey];
    const priorBytes = existing === undefined ? 0 : storageEntryBytes(scopedKey, existing);
    const nextBytes = storageEntryBytes(scopedKey, JSON.parse(serialized)) - priorBytes;
    if (existing === undefined && Object.keys(this.snapshot.values).length >= MAX_STORAGE_ENTRIES) {
      throw new Error(`Runtime storage may contain at most ${MAX_STORAGE_ENTRIES} values.`);
    }
    if (this.storageBytes + nextBytes > MAX_STORAGE_BYTES) {
      throw new Error(`Runtime storage may contain at most ${MAX_STORAGE_BYTES} bytes.`);
    }

    this.snapshot.values[scopedKey] = JSON.parse(serialized) as unknown;
    this.storageBytes += nextBytes;
    this.persist();
  }

  /** Removes one namespaced flow value without affecting other scopes. */
  async deleteValue(scope: PluginStorageScope, ownerId: string, key: string): Promise<void> {
    this.deleteStoredValue(storageKey(scope, ownerId, key));
    this.persist();
  }

  /** Removes one internal value and updates the storage quota accounting. */
  private deleteStoredValue(scopedKey: string): void {
    const existing = this.snapshot.values[scopedKey];
    if (existing !== undefined) this.storageBytes -= storageEntryBytes(scopedKey, existing);
    delete this.snapshot.values[scopedKey];
  }

  /** Flushes pending changes immediately, for startup migration and graceful shutdown. */
  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = undefined;
    }
    while (this.dirty || this.activeWrite) {
      if (this.activeWrite) {
        await this.activeWrite;
        continue;
      }
      await this.writeSnapshot();
    }
  }

  /** Marks the latest snapshot dirty and coalesces repeated changes into one timed write. */
  private persist(): void {
    this.dirty = true;
    this.scheduleWrite();
  }

  /** Schedules one write without retaining a promise or snapshot per mutation. */
  private scheduleWrite(): void {
    if (!this.dirty || this.writeTimer || this.activeWrite) return;
    const elapsed = Date.now() - this.lastWriteAttemptAt;
    const delay = Math.max(0, MIN_PERSIST_INTERVAL_MS - elapsed);
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined;
      void this.writeSnapshot().catch(() => undefined);
    }, delay);
  }

  /** Atomically writes the newest snapshot and schedules another bounded pass if it changed meanwhile. */
  private async writeSnapshot(): Promise<void> {
    if (this.activeWrite) return this.activeWrite;
    if (!this.dirty) return;
    this.dirty = false;
    this.lastWriteAttemptAt = Date.now();
    const data = `${JSON.stringify(structuredClone(this.snapshot), null, 2)}\n`;
    const write = async (): Promise<void> => {
      const temporaryPath = `${this.filePath}.tmp`;
      await writeFile(temporaryPath, data, { mode: 0o600 });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.filePath);
    };
    const activeWrite = write()
      .then(() => {
        this.writeFailureReported = false;
      })
      .catch((error: unknown) => {
        this.dirty = true;
        if (!this.writeFailureReported) {
          this.writeFailureReported = true;
          const detail = error instanceof Error ? error.message : String(error);
          this.logger?.error("Could not persist runtime state.", { component: "runtime-state", detail });
        }
        throw error;
      })
      .finally(() => {
        this.activeWrite = undefined;
        this.scheduleWrite();
      });
    this.activeWrite = activeWrite;
    return activeWrite;
  }
}

function emptySnapshot(): RuntimeSnapshot { return { version: 1, panelSessions: {}, values: {} }; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function storageKey(scope: PluginStorageScope, ownerId: string, key: string): string { return `${scope}:${ownerId}:${key}`; }
function storageEntryBytes(key: string, value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Stored runtime value is not JSON serializable.");
  return Buffer.byteLength(key, "utf8") + Buffer.byteLength(serialized, "utf8") + 3;
}
function measureStorageBytes(values: Record<string, unknown>): number {
  return Object.entries(values).reduce((total, [key, value]) => total + storageEntryBytes(key, value), 0);
}
