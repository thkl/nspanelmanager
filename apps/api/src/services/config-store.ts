import { mkdir, readFile, writeFile, rename, chmod } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { defaultPanelSettings, type ManagerConfig, type Panel } from "../types.js";
import { normalizePanelSettings } from "../domain/panel-settings.js";
import { CredentialEncryption, type EncryptedCredential } from "../features/security/credential-encryption.js";

type PersistedManagerConfig = Omit<ManagerConfig, "broker"> & {
  credentialEncryptionVersion: 1;
  broker: Omit<ManagerConfig["broker"], "password"> & { password: string | EncryptedCredential };
};

type LoadedManagerConfig = Partial<ManagerConfig> & { credentialEncryptionVersion?: unknown };

/**
 * Owns the durable JSON configuration used by the manager runtime.
 *
 * The store is intentionally file-backed for a single-container home setup:
 * it needs no database service and works with Docker's named-volume persistence.
 * Mutations are applied to a cloned snapshot, written to a mode-0600 temporary
 * file, and atomically renamed so a process interruption cannot leave a
 * partially written manager configuration. The MQTT broker password is
 * encrypted before persistence and decrypted only into the server-side snapshot.
 */
export class ConfigStore {
  private config: ManagerConfig = structuredClone(emptyConfig);
  private readonly filePath: string;
  private readonly credentialEncryption: CredentialEncryption;

  /** Creates a store rooted at the data directory with its credential cipher. */
  constructor(dataDir: string, credentialEncryption: CredentialEncryption) {
    this.filePath = path.join(dataDir, "manager.json");
    this.credentialEncryption = credentialEncryption;
  }

  /**
   * Loads persisted state, or writes an empty initial configuration.
   *
   * The data directory receives owner-only permissions when first created.
   * Malformed JSON is surfaced as a startup error instead of being overwritten.
   */
  async load(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const saved = JSON.parse(raw) as LoadedManagerConfig;
      if (saved.credentialEncryptionVersion !== undefined && saved.credentialEncryptionVersion !== 1) {
        throw new Error("The manager configuration uses an unsupported credential encryption version.");
      }
      const pluginConfiguration = migratePluginConfiguration(saved.pluginProfiles, saved.pluginInstances);
      const savedBroker = isRecord(saved.broker as unknown) ? saved.broker as unknown as Record<string, unknown> : {};
      const savedPassword = Object.hasOwn(savedBroker, "password") ? savedBroker.password : "";
      if (saved.credentialEncryptionVersion === 1 && typeof savedPassword === "string" && savedPassword.length > 0) {
        throw new Error("The manager configuration marks broker credentials as encrypted, but contains a plaintext password.");
      }
      const brokerPassword = this.credentialEncryption.decryptStored(savedPassword);
      const credentialFormatNeedsMigration = saved.credentialEncryptionVersion !== 1;
      delete saved.credentialEncryptionVersion;
      this.config = {
        ...emptyConfig,
        ...saved,
        broker: {
          url: typeof savedBroker.url === "string" ? savedBroker.url : emptyConfig.broker.url,
          username: typeof savedBroker.username === "string" ? savedBroker.username : emptyConfig.broker.username,
          password: brokerPassword.value
        },
        firmwareRollout: normalizeFirmwareRolloutSettings(saved.firmwareRollout),
        panels: Array.isArray(saved.panels) ? saved.panels.map((panel) => ({
          ...panel,
          autoUpdateFirmware: panel.autoUpdateFirmware === true,
          ...(normalizeMacAddress(panel.macAddress) ? { macAddress: normalizeMacAddress(panel.macAddress) } : { macAddress: undefined }),
          unifiedFirmware: panel.unifiedFirmware === true && Boolean(normalizeMacAddress(panel.macAddress)),
          nativePluginInstances: normalizeNativePluginInstances(panel.nativePluginInstances),
          panelEventPluginInstances: normalizeNativePluginInstances(panel.panelEventPluginInstances),
          settings: normalizePanelSettings(panel.settings, panel.name)
        })) : [],
        routes: Array.isArray(saved.routes) ? saved.routes : [],
        pluginProfiles: pluginConfiguration.profiles,
        pluginInstances: pluginConfiguration.instances,
        panelBindings: Array.isArray(saved.panelBindings) ? saved.panelBindings : []
      };
      if (pluginConfiguration.migrated || brokerPassword.needsMigration || credentialFormatNeedsMigration) await this.save();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.save();
    }
  }

  /** Returns an isolated copy so callers cannot mutate persistent state by reference. */
  get(): ManagerConfig { return structuredClone(this.config); }

  /**
   * Mutates a cloned configuration snapshot and persists it before returning.
   *
   * Callers should keep the mutator synchronous and focused on one operation.
   * The resulting clone is returned for handlers that need the saved state.
   */
  async update(mutator: (config: ManagerConfig) => void): Promise<ManagerConfig> {
    const next = this.get();
    mutator(next);
    this.config = next;
    await this.save();
    return this.get();
  }

  /** Allocates a stable identifier and appends a new panel profile. */
  async addPanel(input: Omit<Panel, "id">): Promise<Panel> {
    const panel = { ...input, id: randomUUID() };
    await this.update((config) => { config.panels.push(panel); });
    return panel;
  }

  /** Atomically writes current configuration with private file permissions. */
  async save(): Promise<void> {
    const temp = `${this.filePath}.tmp`;
    const persistedConfig: PersistedManagerConfig = {
      ...this.config,
      credentialEncryptionVersion: 1,
      broker: {
        ...this.config.broker,
        password: this.credentialEncryption.encrypt(this.config.broker.password)
      }
    };
    await writeFile(temp, `${JSON.stringify(persistedConfig, null, 2)}\n`, { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, this.filePath);
  }
}

const emptyConfig: ManagerConfig = {
  broker: { url: "", username: "", password: "" },
  firmwareRollout: { enabled: false, stableHours: 3 },
  panels: [], routes: [], pluginProfiles: [], pluginInstances: [], panelBindings: []
};

function normalizeFirmwareRolloutSettings(value: unknown): ManagerConfig["firmwareRollout"] {
  if (!isRecord(value)) return structuredClone(emptyConfig.firmwareRollout);
  const stableHours = typeof value.stableHours === "number" && Number.isInteger(value.stableHours)
    ? Math.min(24, Math.max(1, value.stableHours))
    : emptyConfig.firmwareRollout.stableHours;
  return { enabled: value.enabled === true, stableHours };
}

function migratePluginConfiguration(profilesValue: unknown, instancesValue: unknown): {
  profiles: ManagerConfig["pluginProfiles"];
  instances: ManagerConfig["pluginInstances"];
  migrated: boolean;
} {
  const profiles = Array.isArray(profilesValue) ? profilesValue.filter(isPluginProfile) : [];
  const instances: ManagerConfig["pluginInstances"] = [];
  let migrated = false;
  const usedProfileIds = new Set(profiles.map((profile) => profile.id));

  for (const value of Array.isArray(instancesValue) ? instancesValue : []) {
    if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string" || typeof value.enabled !== "boolean") continue;
    const variables = normalizePluginVariables(value.variables);
    if (typeof value.pluginProfileId === "string") {
      instances.push({
        id: value.id,
        name: value.name,
        pluginProfileId: value.pluginProfileId,
        enabled: value.enabled,
        variables
      });
      continue;
    }

    if (typeof value.pluginId !== "string" || !isRecord(value.config)) continue;
    let profileId = `legacy-${value.id}`;
    let suffix = 1;
    while (usedProfileIds.has(profileId)) profileId = `legacy-${value.id}-${suffix++}`;
    usedProfileIds.add(profileId);
    profiles.push({
      id: profileId,
      name: value.name,
      pluginId: value.pluginId,
      config: value.config as ManagerConfig["pluginProfiles"][number]["config"]
    });
    instances.push({ id: value.id, name: value.name, pluginProfileId: profileId, enabled: value.enabled, variables });
    migrated = true;
  }
  return { profiles, instances, migrated };
}

function isPluginProfile(value: unknown): value is ManagerConfig["pluginProfiles"][number] {
  return isRecord(value) && typeof value.id === "string" && typeof value.name === "string" &&
    typeof value.pluginId === "string" && isRecord(value.config);
}

function normalizePluginVariables(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function normalizeNativePluginInstances(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(entry[1].trim())));
}

function normalizeMacAddress(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/[:-]/g, "").toLowerCase();
  return /^[a-f0-9]{12}$/.test(normalized) ? normalized : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export { defaultPanelSettings };
