import type { PluginState, PluginStorageScope } from "../plugins/plugin-contract.js";
import type { FirmwareRollout, FirmwareUpdateJob, HmiRollout, HmiUpdateJob, PanelResetReport } from "../../types.js";
import type { Logger } from "../../services/logger.js";
import type { SqliteStore } from "../../services/sqlite-store.js";

const MIN_PERSIST_INTERVAL_MS = 1_000;
const MAX_STORAGE_KEY_LENGTH = 256;
const MAX_STORAGE_VALUE_BYTES = 64 * 1024;
const MAX_STORAGE_ENTRIES = 4_096;
const MAX_STORAGE_BYTES = 2 * 1024 * 1024;
const MAX_PERSISTED_PLUGIN_STATES = 512;
const MAX_PLUGIN_STATE_BYTES = 64 * 1024;
const MAX_PERSISTED_PLUGIN_STATE_BYTES = 2 * 1024 * 1024;
const MAX_PERSISTED_HMI_UPDATE_JOBS = 200;
const MAX_PERSISTED_FIRMWARE_UPDATE_JOBS = 200;

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

/** Last requested temporary night and brightness values for one panel group. */
export interface PanelGroupRuntimeSettings {
  night?: 0 | 1;
  brightness?: number;
}

interface RuntimeSnapshot {
  version: 1;
  panelSessions: Record<string, PanelFlowSession>;
  panelResetReports: Record<string, PanelResetReport>;
  panelGroupSettings: Record<string, PanelGroupRuntimeSettings>;
  hmiUpdateJobs: HmiUpdateJob[];
  hmiRollout: HmiRollout | null;
  firmwareUpdateJobs: FirmwareUpdateJob[];
  firmwareRollout: FirmwareRollout | null;
  values: Record<string, unknown>;
  pluginStates: Record<string, PluginState>;
}

/**
 * Keeps normalized plugin state in memory and persists a bounded last-known
 * device snapshot, panel flow and reset reports, and explicitly saved script values.
 * State changes are available in memory immediately and coalesced to a maximum
 * of one snapshot write per second. Device state is limited to 512 instances,
 * 2 MiB total, and 64 KiB per instance. Script storage is limited to 4,096
 * values, 2 MiB total, and 64 KiB per value. Call {@link flush} during graceful
 * shutdown.
 */
export class RuntimeStateStore {
  private snapshot: RuntimeSnapshot = emptySnapshot();
  private readonly pluginStates: Record<string, PluginState> = {};
  private readonly warnedUnpersistedPluginStates = new Set<string>();
  private persistedPluginStateBytes = 0;
  private pluginStateCapacityWarningReported = false;
  private storageBytes = 0;
  private dirty = false;
  private writeTimer?: ReturnType<typeof setTimeout>;
  private activeWrite?: Promise<void>;
  private lastWriteAttemptAt = 0;
  private writeFailureReported = false;

  /** Creates the runtime store over the manager's shared SQLite database. */
  constructor(private readonly database: SqliteStore, private readonly logger?: Logger) { }

  /** Loads durable flow, script values, and the bounded last-known device state snapshot. */
  async load(): Promise<void> {
    const serialized = this.database.readDocument("runtime-state");
    if (serialized === undefined) {
      this.persist();
      await this.flush();
      return;
    }
    const value: unknown = JSON.parse(serialized);
    if (!isRecord(value)) throw new Error("The saved runtime state is invalid; refusing to replace it.");
    // Normalize each persisted collection before merging so older snapshots gain defaults safely.
    const rawPluginStates = isRecord(value.pluginStates) ? value.pluginStates : {};
    const pluginStates = normalizePluginStates(rawPluginStates);
    const panelResetReports = normalizePanelResetReports(value.panelResetReports);
    const panelGroupSettings = normalizePanelGroupSettings(value.panelGroupSettings);
    const hmiUpdateJobs = normalizeHmiUpdateJobs(value.hmiUpdateJobs);
    const hmiRollout = normalizeHmiRollout(value.hmiRollout);
    const firmwareUpdateJobs = normalizeFirmwareUpdateJobs(value.firmwareUpdateJobs);
    const firmwareRollout = normalizeFirmwareRollout(value.firmwareRollout);
    this.snapshot = {
      version: 1,
      panelSessions: isRecord(value.panelSessions) ? value.panelSessions as Record<string, PanelFlowSession> : {},
      panelResetReports,
      panelGroupSettings,
      hmiUpdateJobs,
      hmiRollout,
      firmwareUpdateJobs,
      firmwareRollout,
      values: isRecord(value.values) ? value.values : {},
      pluginStates
    };
    for (const key of Object.keys(this.pluginStates)) delete this.pluginStates[key];
    Object.assign(this.pluginStates, structuredClone(pluginStates));
    this.persistedPluginStateBytes = measurePluginStateBytes(pluginStates);
    this.storageBytes = measureStorageBytes(this.snapshot.values);
    const needsSnapshotUpgrade = !Object.hasOwn(value, "pluginStates")
      || !isRecord(value.pluginStates)
      || JSON.stringify(value.pluginStates) !== JSON.stringify(pluginStates)
      || !Object.hasOwn(value, "panelResetReports")
      || JSON.stringify(value.panelResetReports) !== JSON.stringify(panelResetReports)
      || !Object.hasOwn(value, "panelGroupSettings")
      || JSON.stringify(value.panelGroupSettings) !== JSON.stringify(panelGroupSettings)
      || !Array.isArray(value.hmiUpdateJobs)
      || JSON.stringify(value.hmiUpdateJobs) !== JSON.stringify(hmiUpdateJobs)
      || !Object.hasOwn(value, "hmiRollout")
      || JSON.stringify(value.hmiRollout) !== JSON.stringify(hmiRollout)
      || !Array.isArray(value.firmwareUpdateJobs)
      || JSON.stringify(value.firmwareUpdateJobs) !== JSON.stringify(firmwareUpdateJobs)
      || !Object.hasOwn(value, "firmwareRollout")
      || JSON.stringify(value.firmwareRollout) !== JSON.stringify(firmwareRollout);
    if (needsSnapshotUpgrade) {
      this.persist();
      await this.flush();
    }
  }

  /** Returns a defensive copy of one plugin instance's current last-known state. */
  getPluginState(instanceId: string): PluginState { return structuredClone(this.pluginStates[instanceId] ?? {}); }

  /** Updates in-memory state immediately and schedules a bounded durable snapshot. */
  async setPluginState(instanceId: string, state: PluginState): Promise<void> {
    const currentState = structuredClone(state);
    this.pluginStates[instanceId] = currentState;

    let serialized: string | undefined;
    try { serialized = JSON.stringify(currentState); }
    catch { /* Non-JSON state remains available in memory but cannot be restored after restart. */ }
    if (serialized === undefined) {
      this.dropPersistedPluginState(instanceId);
      this.warnUnpersistedPluginState(instanceId, "state is not JSON serializable");
      return;
    }

    const persistedState = JSON.parse(serialized) as PluginState;
    const entryBytes = storageEntryBytes(instanceId, persistedState);
    if (entryBytes > MAX_PLUGIN_STATE_BYTES) {
      this.dropPersistedPluginState(instanceId);
      this.warnUnpersistedPluginState(instanceId, `state exceeds ${MAX_PLUGIN_STATE_BYTES} bytes`);
      return;
    }

    this.warnedUnpersistedPluginStates.delete(instanceId);
    this.dropPersistedPluginState(instanceId);
    this.snapshot.pluginStates[instanceId] = persistedState;
    this.persistedPluginStateBytes += entryBytes;
    let capacityReached = false;
    while (Object.keys(this.snapshot.pluginStates).length > MAX_PERSISTED_PLUGIN_STATES
      || this.persistedPluginStateBytes > MAX_PERSISTED_PLUGIN_STATE_BYTES) {
      const oldestInstanceId = Object.keys(this.snapshot.pluginStates).find((key) => key !== instanceId);
      if (oldestInstanceId) {
        this.persistedPluginStateBytes -= storageEntryBytes(oldestInstanceId, this.snapshot.pluginStates[oldestInstanceId]);
        delete this.snapshot.pluginStates[oldestInstanceId];
        capacityReached = true;
        continue;
      }
      this.persistedPluginStateBytes -= storageEntryBytes(instanceId, this.snapshot.pluginStates[instanceId]);
      delete this.snapshot.pluginStates[instanceId];
      capacityReached = true;
      break;
    }
    if (capacityReached && !this.pluginStateCapacityWarningReported) {
      this.pluginStateCapacityWarningReported = true;
      this.logger?.warn("Device state snapshot reached its configured capacity; older device state remains in memory only.", {
        component: "runtime-state"
      });
    }
    this.persist();
  }

  /** Removes in-memory device state, active flow context, and scoped values when an instance is deleted. */
  async removePluginInstance(instanceId: string): Promise<void> {
    delete this.pluginStates[instanceId];
    this.dropPersistedPluginState(instanceId);
    this.warnedUnpersistedPluginStates.delete(instanceId);
    for (const [panelId, session] of Object.entries(this.snapshot.panelSessions)) {
      if (session.pluginInstanceId === instanceId) delete this.snapshot.panelSessions[panelId];
    }
    for (const key of Object.keys(this.snapshot.values)) {
      if (key.startsWith(`plugin:${instanceId}:`)) this.deleteStoredValue(key);
    }
    this.persist();
  }

  /** Removes an instance's durable snapshot if a later message cannot be saved. */
  private dropPersistedPluginState(instanceId: string): void {
    const state = this.snapshot.pluginStates[instanceId];
    if (state === undefined) return;
    this.persistedPluginStateBytes -= storageEntryBytes(instanceId, state);
    delete this.snapshot.pluginStates[instanceId];
    this.persist();
  }

  /** Reports once per instance when its latest state cannot survive a restart. */
  private warnUnpersistedPluginState(instanceId: string, reason: string): void {
    if (this.warnedUnpersistedPluginStates.has(instanceId)) return;
    this.warnedUnpersistedPluginStates.add(instanceId);
    this.logger?.warn("Latest device state will remain in memory only.", {
      component: "runtime-state",
      instanceId,
      reason
    });
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

  /** Returns the latest durable reboot report received for one panel. */
  getPanelResetReport(panelId: string): PanelResetReport | undefined {
    const report = this.snapshot.panelResetReports[panelId];
    return report ? structuredClone(report) : undefined;
  }

  /** Saves the latest reboot report independently from panel configuration and script values. */
  async setPanelResetReport(panelId: string, report: PanelResetReport): Promise<void> {
    this.snapshot.panelResetReports[panelId] = structuredClone(report);
    this.persist();
  }

  /** Clears the saved reboot report so acknowledged historical failures stop raising alerts. */
  async clearPanelResetReport(panelId: string): Promise<void> {
    if (!this.snapshot.panelResetReports[panelId]) return;
    delete this.snapshot.panelResetReports[panelId];
    this.persist();
    await this.flush();
  }

  /** Returns the last temporary runtime settings received for a panel group. */
  getPanelGroupSettings(groupName: string): PanelGroupRuntimeSettings | undefined {
    const settings = this.snapshot.panelGroupSettings[groupName];
    return settings ? structuredClone(settings) : undefined;
  }

  /** Saves a panel group's temporary runtime settings for replay after display reconnects. */
  async setPanelGroupSettings(groupName: string, settings: PanelGroupRuntimeSettings): Promise<void> {
    this.snapshot.panelGroupSettings[groupName] = structuredClone(settings);
    this.persist();
  }

  /** Returns the recent durable HMI update history, newest activity first. */
  getHmiUpdateJobs(): HmiUpdateJob[] { return structuredClone(this.snapshot.hmiUpdateJobs); }

  /** Inserts or replaces an HMI update record and bounds retained history. */
  async upsertHmiUpdateJob(job: HmiUpdateJob): Promise<void> {
    const jobs = this.snapshot.hmiUpdateJobs.filter((item) => item.id !== job.id);
    jobs.push(structuredClone(job));
    jobs.sort((left, right) => right.updatedAt - left.updatedAt);
    this.snapshot.hmiUpdateJobs = jobs.slice(0, MAX_PERSISTED_HMI_UPDATE_JOBS);
    this.persist();
  }

  /** Returns the active or most recently completed staged HMI rollout. */
  getHmiRollout(): HmiRollout | null {
    return this.snapshot.hmiRollout ? structuredClone(this.snapshot.hmiRollout) : null;
  }

  /** Persists the canary-first HMI rollout and its queued panel identifiers. */
  async setHmiRollout(rollout: HmiRollout | null): Promise<void> {
    this.snapshot.hmiRollout = rollout ? structuredClone(rollout) : null;
    this.persist();
  }

  /** Returns recent durable firmware update jobs, newest activity first. */
  getFirmwareUpdateJobs(): FirmwareUpdateJob[] { return structuredClone(this.snapshot.firmwareUpdateJobs); }

  /** Inserts or replaces a firmware update record and bounds retained history. */
  async upsertFirmwareUpdateJob(job: FirmwareUpdateJob): Promise<void> {
    const jobs = this.snapshot.firmwareUpdateJobs.filter((item) => item.id !== job.id);
    jobs.push(structuredClone(job));
    jobs.sort((left, right) => right.updatedAt - left.updatedAt);
    this.snapshot.firmwareUpdateJobs = jobs.slice(0, MAX_PERSISTED_FIRMWARE_UPDATE_JOBS);
    this.persist();
  }

  /** Returns the active or most recently completed firmware rollout. */
  getFirmwareRollout(): FirmwareRollout | null {
    return this.snapshot.firmwareRollout ? structuredClone(this.snapshot.firmwareRollout) : null;
  }

  /** Persists rollout progress, its stability timer, and the remaining panel queue. */
  async setFirmwareRollout(rollout: FirmwareRollout | null): Promise<void> {
    this.snapshot.firmwareRollout = rollout ? structuredClone(rollout) : null;
    this.persist();
  }

  /** Removes one panel's restored flow state when its saved profile is deleted. */
  async removePanel(panelId: string): Promise<void> {
    delete this.snapshot.panelSessions[panelId];
    delete this.snapshot.panelResetReports[panelId];
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
    const activeWrite = Promise.resolve()
      .then(() => this.database.writeDocument("runtime-state", 1, data))
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

function emptySnapshot(): RuntimeSnapshot { return { version: 1, panelSessions: {}, panelResetReports: {}, panelGroupSettings: {}, hmiUpdateJobs: [], hmiRollout: null, firmwareUpdateJobs: [], firmwareRollout: null, values: {}, pluginStates: {} }; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

function normalizePanelGroupSettings(value: unknown): Record<string, PanelGroupRuntimeSettings> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([groupName, candidate]) => {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(groupName) || !isRecord(candidate)) return [];
    const settings: PanelGroupRuntimeSettings = {};
    if (candidate.night === 0 || candidate.night === 1) settings.night = candidate.night;
    if (typeof candidate.brightness === "number" && Number.isInteger(candidate.brightness) && candidate.brightness >= 0 && candidate.brightness <= 100) {
      settings.brightness = candidate.brightness;
    }
    return Object.keys(settings).length ? [[groupName, settings]] : [];
  }));
}

function normalizePanelResetReports(value: unknown): Record<string, PanelResetReport> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([panelId, candidate]) => {
    if (!panelId || !isRecord(candidate) || typeof candidate.reason !== "string" || typeof candidate.reportedAt !== "number" || !Number.isFinite(candidate.reportedAt)) return [];
    const reason = candidate.reason.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
    return reason ? [[panelId, { reason, reportedAt: candidate.reportedAt }]] : [];
  }));
}

function normalizeHmiUpdateJobs(value: unknown): HmiUpdateJob[] {
  if (!Array.isArray(value)) return [];
  const validStatuses = new Set<HmiUpdateJob["status"]>(["sending", "sent", "awaiting_confirmation", "uploading", "succeeded", "failed", "cancelled", "timed_out"]);
  const jobs = value.flatMap((candidate): HmiUpdateJob[] => {
    if (!isRecord(candidate)
      || typeof candidate.id !== "string" || !/^[0-9a-f-]{36}$/i.test(candidate.id)
      || typeof candidate.panelId !== "string" || !candidate.panelId
      || typeof candidate.panelName !== "string" || !candidate.panelName
      || typeof candidate.nodeName !== "string" || !candidate.nodeName
      || typeof candidate.artifactId !== "string" || !/^[0-9a-f-]{36}$/i.test(candidate.artifactId)
      || typeof candidate.filename !== "string" || !candidate.filename
      || typeof candidate.hmiVersion !== "string" || !/^[0-9a-f]{64}$/.test(candidate.hmiVersion)
      || typeof candidate.status !== "string" || !validStatuses.has(candidate.status as HmiUpdateJob["status"])
      || typeof candidate.force !== "boolean"
      || typeof candidate.requestedAt !== "number" || !Number.isFinite(candidate.requestedAt) || candidate.requestedAt < 0
      || typeof candidate.updatedAt !== "number" || !Number.isFinite(candidate.updatedAt) || candidate.updatedAt < 0
      || typeof candidate.expiresAt !== "number" || !Number.isFinite(candidate.expiresAt) || candidate.expiresAt < 0) return [];
    const message = typeof candidate.message === "string" ? candidate.message.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 160) : "";
    const requestedBy = typeof candidate.requestedBy === "string" ? candidate.requestedBy.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 160) : "";
    return [{
      id: candidate.id,
      panelId: candidate.panelId.slice(0, 80),
      panelName: candidate.panelName.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120),
      nodeName: candidate.nodeName.slice(0, 100),
      artifactId: candidate.artifactId,
      filename: candidate.filename.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 180),
      hmiVersion: candidate.hmiVersion,
      status: candidate.status as HmiUpdateJob["status"],
      force: candidate.force,
      requestedAt: candidate.requestedAt,
      updatedAt: candidate.updatedAt,
      expiresAt: candidate.expiresAt,
      ...(message ? { message } : {}),
      ...(requestedBy ? { requestedBy } : {})
    }];
  });
  return jobs.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, MAX_PERSISTED_HMI_UPDATE_JOBS);
}

function normalizeHmiRollout(value: unknown): HmiRollout | null {
  if (!isRecord(value)
    || typeof value.id !== "string" || !/^[0-9a-f-]{36}$/i.test(value.id)
    || typeof value.artifactId !== "string" || !/^[0-9a-f-]{36}$/i.test(value.artifactId)
    || typeof value.hmiVersion !== "string" || !/^[0-9a-f]{64}$/i.test(value.hmiVersion)
    || typeof value.canaryPanelId !== "string" || !value.canaryPanelId
    || typeof value.canaryPanelName !== "string" || !value.canaryPanelName
    || typeof value.force !== "boolean"
    || typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt) || value.startedAt < 0
    || typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt) || value.updatedAt < 0
    || typeof value.status !== "string" || !["updating", "completed", "failed", "cancelled"].includes(value.status)
    || !Array.isArray(value.pendingPanelIds)
    || typeof value.message !== "string") return null;
  const pendingPanelIds = value.pendingPanelIds
    .filter((panelId): panelId is string => typeof panelId === "string" && panelId.length > 0)
    .slice(0, 512);
  const currentPanelId = typeof value.currentPanelId === "string" && value.currentPanelId
    ? value.currentPanelId.slice(0, 80)
    : undefined;
  const currentJobId = typeof value.currentJobId === "string" && /^[0-9a-f-]{36}$/i.test(value.currentJobId)
    ? value.currentJobId
    : undefined;
  return {
    id: value.id,
    artifactId: value.artifactId,
    hmiVersion: value.hmiVersion.toLowerCase(),
    canaryPanelId: value.canaryPanelId.slice(0, 80),
    canaryPanelName: value.canaryPanelName.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120),
    ...(currentPanelId ? { currentPanelId } : {}),
    ...(currentJobId ? { currentJobId } : {}),
    pendingPanelIds,
    force: value.force,
    status: value.status as HmiRollout["status"],
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    message: value.message.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 240)
  };
}

function normalizeFirmwareUpdateJobs(value: unknown): FirmwareUpdateJob[] {
  if (!Array.isArray(value)) return [];
  const validStatuses = new Set<FirmwareUpdateJob["status"]>(["sending", "sent", "awaiting_confirmation", "uploading", "rebooting", "succeeded", "failed", "cancelled", "timed_out"]);
  const jobs = value.flatMap((candidate): FirmwareUpdateJob[] => {
    if (!isRecord(candidate)
      || typeof candidate.id !== "string" || !/^[0-9a-f-]{36}$/i.test(candidate.id)
      || typeof candidate.panelId !== "string" || !candidate.panelId
      || typeof candidate.panelName !== "string" || !candidate.panelName
      || typeof candidate.nodeName !== "string" || !candidate.nodeName
      || typeof candidate.artifactId !== "string" || !/^[0-9a-f-]{36}$/i.test(candidate.artifactId)
      || typeof candidate.filename !== "string" || !candidate.filename.toLowerCase().endsWith(".bin")
      || typeof candidate.firmwareVersion !== "string" || !/^[0-9A-Za-z._+-]{1,40}$/.test(candidate.firmwareVersion)
      || typeof candidate.status !== "string" || !validStatuses.has(candidate.status as FirmwareUpdateJob["status"])
      || typeof candidate.force !== "boolean"
      || typeof candidate.requestedAt !== "number" || !Number.isFinite(candidate.requestedAt) || candidate.requestedAt < 0
      || typeof candidate.updatedAt !== "number" || !Number.isFinite(candidate.updatedAt) || candidate.updatedAt < 0
      || typeof candidate.expiresAt !== "number" || !Number.isFinite(candidate.expiresAt) || candidate.expiresAt < 0) return [];
    const message = typeof candidate.message === "string" ? candidate.message.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 160) : "";
    const requestedBy = typeof candidate.requestedBy === "string" ? candidate.requestedBy.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 160) : "";
    const progress = typeof candidate.progress === "number" && Number.isInteger(candidate.progress) && candidate.progress >= 0 && candidate.progress <= 100 ? candidate.progress : undefined;
    return [{
      id: candidate.id,
      panelId: candidate.panelId.slice(0, 80),
      panelName: candidate.panelName.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120),
      nodeName: candidate.nodeName.slice(0, 100),
      artifactId: candidate.artifactId,
      filename: candidate.filename.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 180),
      firmwareVersion: candidate.firmwareVersion,
      status: candidate.status as FirmwareUpdateJob["status"],
      force: candidate.force,
      requestedAt: candidate.requestedAt,
      updatedAt: candidate.updatedAt,
      expiresAt: candidate.expiresAt,
      ...(progress === undefined ? {} : { progress }),
      ...(message ? { message } : {}),
      ...(requestedBy ? { requestedBy } : {})
    }];
  });
  return jobs.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, MAX_PERSISTED_FIRMWARE_UPDATE_JOBS);
}

function normalizeFirmwareRollout(value: unknown): FirmwareRollout | null {
  if (!isRecord(value)
    || typeof value.id !== "string" || !/^[0-9a-f-]{36}$/i.test(value.id)
    || typeof value.artifactId !== "string" || !/^[0-9a-f-]{36}$/i.test(value.artifactId)
    || typeof value.firmwareVersion !== "string" || !/^[0-9A-Za-z._+-]{1,40}$/.test(value.firmwareVersion)
    || typeof value.canaryPanelId !== "string" || !value.canaryPanelId
    || typeof value.canaryPanelName !== "string" || !value.canaryPanelName
    || typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt) || value.startedAt < 0
    || typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt) || value.updatedAt < 0
    || typeof value.stableHours !== "number" || !Number.isInteger(value.stableHours) || value.stableHours < 1 || value.stableHours > 24
    || typeof value.status !== "string" || !["monitoring", "updating", "completed", "failed", "cancelled"].includes(value.status)
    || typeof value.canaryConfirmed !== "boolean" || !Array.isArray(value.pendingPanelIds)
    || typeof value.message !== "string") return null;
  const pendingPanelIds = value.pendingPanelIds.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, 512);
  const message = value.message.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 240);
  const stableSinceAt = typeof value.stableSinceAt === "number" && Number.isFinite(value.stableSinceAt) && value.stableSinceAt >= 0 ? value.stableSinceAt : undefined;
  const lastHeartbeatAt = typeof value.lastHeartbeatAt === "number" && Number.isFinite(value.lastHeartbeatAt) && value.lastHeartbeatAt >= 0 ? value.lastHeartbeatAt : undefined;
  const lastUptimeSeconds = typeof value.lastUptimeSeconds === "number" && Number.isFinite(value.lastUptimeSeconds) && value.lastUptimeSeconds >= 0 ? value.lastUptimeSeconds : undefined;
  const currentPanelId = typeof value.currentPanelId === "string" && value.currentPanelId ? value.currentPanelId : undefined;
  return {
    id: value.id,
    artifactId: value.artifactId,
    firmwareVersion: value.firmwareVersion,
    canaryPanelId: value.canaryPanelId.slice(0, 80),
    canaryPanelName: value.canaryPanelName.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120),
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    stableHours: value.stableHours,
    status: value.status as FirmwareRollout["status"],
    canaryConfirmed: value.canaryConfirmed,
    pendingPanelIds,
    ...(currentPanelId ? { currentPanelId: currentPanelId.slice(0, 80) } : {}),
    ...(stableSinceAt === undefined ? {} : { stableSinceAt }),
    ...(lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt }),
    ...(lastUptimeSeconds === undefined ? {} : { lastUptimeSeconds }),
    message
  };
}

function storageKey(scope: PluginStorageScope, ownerId: string, key: string): string { return `${scope}:${ownerId}:${key}`; }
function storageEntryBytes(key: string, value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Stored runtime value is not JSON serializable.");
  return Buffer.byteLength(key, "utf8") + Buffer.byteLength(serialized, "utf8") + 3;
}
function measureStorageBytes(values: Record<string, unknown>): number {
  return Object.entries(values).reduce((total, [key, value]) => total + storageEntryBytes(key, value), 0);
}
function measurePluginStateBytes(states: Record<string, PluginState>): number {
  return Object.entries(states).reduce((total, [instanceId, state]) => total + storageEntryBytes(instanceId, state), 0);
}

/** Keeps the newest valid state entries while enforcing the on-disk state limits. */
function normalizePluginStates(value: Record<string, unknown>): Record<string, PluginState> {
  const newestFirst: Array<[string, PluginState]> = [];
  let storedBytes = 0;
  for (const [instanceId, candidate] of Object.entries(value).reverse()) {
    if (!instanceId || !isRecord(candidate)) continue;
    let serialized: string | undefined;
    try { serialized = JSON.stringify(candidate); }
    catch { continue; }
    if (serialized === undefined) continue;
    const state = JSON.parse(serialized) as PluginState;
    const entryBytes = storageEntryBytes(instanceId, state);
    if (entryBytes > MAX_PLUGIN_STATE_BYTES || newestFirst.length >= MAX_PERSISTED_PLUGIN_STATES
      || storedBytes + entryBytes > MAX_PERSISTED_PLUGIN_STATE_BYTES) continue;
    newestFirst.push([instanceId, state]);
    storedBytes += entryBytes;
  }
  return Object.fromEntries(newestFirst.reverse());
}
