import { randomUUID } from "node:crypto";
import { defaultPanelSettings, type BackupSettings, type HttpLogTransportSettings, type ManagerConfig, type Panel, type PluginConfigValue, type PluginProfile } from "../types.js";
import { normalizePanelSettings } from "../domain/panel-settings.js";
import { CredentialEncryption, type EncryptedCredential } from "../features/security/credential-encryption.js";
import type { ConfigRevisionMetadata, ConfigRevisionSummary, SqliteStore } from "./sqlite-store.js";

const HOME_ASSISTANT_SECRET_PURPOSE = "plugin:home-assistant:access-token";
const HTTP_LOG_BEARER_PURPOSE = "http-log:bearer-token";
const HTTP_LOG_PASSWORD_PURPOSE = "http-log:basic-password";

export type ConfigRevisionScopeType = "panel" | "plugin-profile" | "plugin-instance";

/** Safe selector details for one object that can be restored from a revision. */
export interface ConfigRevisionScopeTarget {
  id: string;
  name: string;
  details?: string;
}

/** Available scoped restore targets in a revision, limited to objects still present now. */
export interface ConfigRevisionScopes {
  panels: ConfigRevisionScopeTarget[];
  pluginProfiles: ConfigRevisionScopeTarget[];
  pluginInstances: ConfigRevisionScopeTarget[];
}

type PersistedPluginProfile = Omit<PluginProfile, "config"> & {
  config: Record<string, PluginConfigValue | EncryptedCredential>;
};

type PersistedManagerConfig = Omit<ManagerConfig, "broker" | "httpLogTransport" | "pluginProfiles"> & {
  credentialEncryptionVersion: 1;
  broker: Omit<ManagerConfig["broker"], "password"> & { password: string | EncryptedCredential };
  httpLogTransport: Omit<HttpLogTransportSettings, "bearerToken" | "password"> & {
    bearerToken: string | EncryptedCredential;
    password: string | EncryptedCredential;
  };
  pluginProfiles: PersistedPluginProfile[];
};

type LoadedManagerConfig = Partial<ManagerConfig> & { credentialEncryptionVersion?: unknown };

/**
 * Owns the durable manager configuration and its revision history. The active
 * configuration remains a typed in-memory snapshot for current runtime callers,
 * while SQLite transactions persist encrypted documents and revision records.
 * MQTT broker passwords and Home Assistant access tokens are encrypted before
 * persistence and decrypted only into the server-side snapshot.
 */
export class ConfigStore {
  private config: ManagerConfig = structuredClone(emptyConfig);
  private readonly credentialEncryption: CredentialEncryption;

  /** Creates the configuration store over the shared SQLite database and credential cipher. */
  constructor(private readonly database: SqliteStore, credentialEncryption: CredentialEncryption) {
    this.credentialEncryption = credentialEncryption;
  }

  /**
   * Loads persisted state, or writes an empty initial configuration.
   * Malformed or unsupported saved data is surfaced as a startup error instead
   * of being overwritten.
   */
  async load(): Promise<void> {
    const raw = this.database.readDocument("manager");
    if (raw !== undefined) {
      const loaded = this.deserializeStoredConfig(raw);
      this.config = loaded.config;
      if (loaded.needsMigration) await this.save();
    } else {
      this.config = structuredClone(emptyConfig);
      await this.save();
    }
    this.database.ensureInitialConfigRevision(this.serializeForStorage());
  }

  /** Returns an isolated copy so callers cannot mutate persistent state by reference. */
  get(): ManagerConfig { return structuredClone(this.config); }

  /**
   * Mutates a cloned configuration snapshot and persists it before returning.
   *
   * Callers should keep the mutator synchronous and focused on one operation.
   * The resulting clone is returned for handlers that need the saved state.
   */
  async update(mutator: (config: ManagerConfig) => void, revision: ConfigRevisionMetadata = {
    actor: "system",
    summary: "Configuration updated"
  }): Promise<ManagerConfig> {
    const next = this.get();
    mutator(next);
    if (JSON.stringify(next) === JSON.stringify(this.config)) return this.get();
    const previous = this.config;
    this.config = next;
    try {
      await this.save(revision);
    } catch (error) {
      // Keep the in-memory snapshot aligned with SQLite if durable persistence rejected the mutation.
      this.config = previous;
      throw error;
    }
    return this.get();
  }

  /** Allocates a stable identifier and appends a new panel profile. */
  async addPanel(input: Omit<Panel, "id">, revision: ConfigRevisionMetadata = {
    actor: "system",
    summary: `Panel '${input.name}' created`
  }): Promise<Panel> {
    const panel = { ...input, id: randomUUID() };
    await this.update((config) => { config.panels.push(panel); }, revision);
    return panel;
  }

  /** Atomically stores current configuration and, for user changes, a recoverable revision. */
  async save(revision?: ConfigRevisionMetadata): Promise<void> {
    const serialized = this.serializeForStorage();
    if (revision) this.database.saveManagerConfig(serialized, revision);
    else this.database.writeDocument("manager", 1, serialized);
  }

  /** Returns configuration history without returning encrypted configuration payloads. */
  listRevisions(limit = 100): ConfigRevisionSummary[] {
    return this.database.listConfigRevisions(limit);
  }

  /** Reads an encrypted historical configuration snapshot for a privileged restore operation. */
  readRevision(id: number): string | undefined {
    return this.database.readConfigRevision(id);
  }

  /** Lists restorable panels, plugin profiles, and instances without returning their configuration values. */
  getRevisionScopes(id: number): ConfigRevisionScopes | undefined {
    const raw = this.readRevision(id);
    if (raw === undefined) return undefined;
    const historical = this.deserializeStoredConfig(raw).config;
    const current = this.config;
    const currentPanelIds = new Set(current.panels.map((panel) => panel.id));
    const currentProfileIds = new Set(current.pluginProfiles.map((profile) => profile.id));
    const currentInstanceIds = new Set(current.pluginInstances.map((instance) => instance.id));

    return {
      panels: historical.panels
        .filter((panel) => currentPanelIds.has(panel.id))
        .map((panel) => {
          const currentPanel = current.panels.find((item) => item.id === panel.id);
          const savedLabel = panel.name === currentPanel?.name ? panel.nodeName : `saved as ${panel.name} · ${panel.nodeName}`;
          return { id: panel.id, name: currentPanel?.name ?? panel.name, details: savedLabel };
        }),
      pluginProfiles: historical.pluginProfiles
        .filter((profile) => currentProfileIds.has(profile.id))
        .map((profile) => ({ id: profile.id, name: profile.name, details: profile.pluginId })),
      pluginInstances: historical.pluginInstances
        .filter((instance) => currentInstanceIds.has(instance.id) && currentProfileIds.has(instance.pluginProfileId))
        .map((instance) => {
          const profile = historical.pluginProfiles.find((item) => item.id === instance.pluginProfileId);
          return { id: instance.id, name: instance.name, details: profile?.name ?? "Plugin profile" };
        })
    };
  }

  /** Restores one panel, plugin profile, or plugin instance from a saved revision. */
  async restoreRevisionScope(
    revisionId: number,
    scope: ConfigRevisionScopeType,
    targetId: string,
    actor: string
  ): Promise<ManagerConfig | undefined> {
    const raw = this.readRevision(revisionId);
    if (raw === undefined) return undefined;
    const historical = this.deserializeStoredConfig(raw).config;
    const current = this.get();
    let summary: string;

    if (scope === "panel") {
      const savedPanel = historical.panels.find((panel) => panel.id === targetId);
      const currentPanel = current.panels.find((panel) => panel.id === targetId);
      if (!savedPanel || !currentPanel) return undefined;
      const restoredPanel: Panel = {
        ...savedPanel,
        id: currentPanel.id,
        name: currentPanel.name,
        nodeName: currentPanel.nodeName,
        macAddress: currentPanel.macAddress,
        unifiedFirmware: currentPanel.unifiedFirmware,
        settings: {
          ...savedPanel.settings,
          panelname: currentPanel.settings.panelname
        }
      };
      current.panels = current.panels.map((panel) => panel.id === targetId ? restoredPanel : panel);
      const availableInstanceIds = new Set(current.pluginInstances.map((instance) => instance.id));
      current.panelBindings = [
        ...current.panelBindings.filter((binding) => binding.panelId !== targetId),
        ...historical.panelBindings.filter((binding) => binding.panelId === targetId && availableInstanceIds.has(binding.pluginInstanceId))
      ];
      summary = `Restored settings for panel '${currentPanel.name}' from revision ${revisionId}`;
    } else if (scope === "plugin-profile") {
      const savedProfile = historical.pluginProfiles.find((profile) => profile.id === targetId);
      const currentProfile = current.pluginProfiles.find((profile) => profile.id === targetId);
      if (!savedProfile || !currentProfile) return undefined;
      current.pluginProfiles = current.pluginProfiles.map((profile) => profile.id === targetId ? savedProfile : profile);
      summary = `Restored plugin profile '${currentProfile.name}' from revision ${revisionId}`;
    } else {
      const savedInstance = historical.pluginInstances.find((instance) => instance.id === targetId);
      const currentInstance = current.pluginInstances.find((instance) => instance.id === targetId);
      const profileExists = current.pluginProfiles.some((profile) => profile.id === savedInstance?.pluginProfileId);
      if (!savedInstance || !currentInstance || !profileExists) return undefined;
      current.pluginInstances = current.pluginInstances.map((instance) => instance.id === targetId ? savedInstance : instance);
      summary = `Restored plugin instance '${currentInstance.name}' from revision ${revisionId}`;
    }

    return this.update((config) => {
      Object.assign(config, current);
    }, { actor, summary });
  }

  /** Restores one saved configuration snapshot and records that restore as a new revision. */
  async restoreRevision(id: number, actor: string): Promise<ManagerConfig | undefined> {
    const revision = this.readRevision(id);
    if (revision === undefined) return undefined;
    const previousConfig = this.config;
    const previousDocument = this.serializeForStorage();
    this.database.writeDocument("manager", 1, revision);
    try {
      await this.load();
      await this.save({ actor, summary: `Restored configuration revision ${id}` });
      return this.get();
    } catch (error) {
      this.config = previousConfig;
      this.database.writeDocument("manager", 1, previousDocument);
      throw error;
    }
  }

  /** Converts an encrypted persisted document into the normalized runtime configuration without changing SQLite. */
  private deserializeStoredConfig(raw: string): { config: ManagerConfig; needsMigration: boolean } {
    const saved = JSON.parse(raw) as LoadedManagerConfig;
    if (saved.credentialEncryptionVersion !== undefined && saved.credentialEncryptionVersion !== 1) {
      throw new Error("The manager configuration uses an unsupported credential encryption version.");
    }
    const pluginConfiguration = migratePluginConfiguration(saved.pluginProfiles, saved.pluginInstances);
    const pluginProfiles = decryptHomeAssistantTokens(pluginConfiguration.profiles, this.credentialEncryption);
    const savedBroker = isRecord(saved.broker as unknown) ? saved.broker as unknown as Record<string, unknown> : {};
    const savedPassword = Object.hasOwn(savedBroker, "password") ? savedBroker.password : "";
    if (saved.credentialEncryptionVersion === 1 && typeof savedPassword === "string" && savedPassword.length > 0) {
      throw new Error("The manager configuration marks broker credentials as encrypted, but contains a plaintext password.");
    }
    const brokerPassword = this.credentialEncryption.decryptStored(savedPassword);
    const savedHttpLogTransport = isRecord(saved.httpLogTransport as unknown)
      ? saved.httpLogTransport as unknown as Record<string, unknown>
      : {};
    const bearerToken = this.credentialEncryption.decryptStored(
      Object.hasOwn(savedHttpLogTransport, "bearerToken") ? savedHttpLogTransport.bearerToken : "",
      HTTP_LOG_BEARER_PURPOSE
    );
    const httpPassword = this.credentialEncryption.decryptStored(
      Object.hasOwn(savedHttpLogTransport, "password") ? savedHttpLogTransport.password : "",
      HTTP_LOG_PASSWORD_PURPOSE
    );
    const credentialFormatNeedsMigration = saved.credentialEncryptionVersion !== 1;
    delete saved.credentialEncryptionVersion;
    const config: ManagerConfig = {
      ...emptyConfig,
      ...saved,
      backupSettings: normalizeBackupSettings(saved.backupSettings),
      broker: {
        url: typeof savedBroker.url === "string" ? savedBroker.url : emptyConfig.broker.url,
        username: typeof savedBroker.username === "string" ? savedBroker.username : emptyConfig.broker.username,
        password: brokerPassword.value
      },
      httpLogTransport: normalizeHttpLogTransportSettings({
        ...savedHttpLogTransport,
        bearerToken: bearerToken.value,
        password: httpPassword.value
      }),
      firmwareRollout: normalizeFirmwareRolloutSettings(saved.firmwareRollout),
      panels: Array.isArray(saved.panels) ? saved.panels.map((panel) => ({
        ...panel,
        ...(typeof panel.groupName === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(panel.groupName) ? { groupName: panel.groupName } : { groupName: undefined }),
        autoUpdateFirmware: panel.autoUpdateFirmware === true,
        healthNotificationsEnabled: panel.healthNotificationsEnabled !== false,
        ...(normalizeMacAddress(panel.macAddress) ? { macAddress: normalizeMacAddress(panel.macAddress) } : { macAddress: undefined }),
        unifiedFirmware: panel.unifiedFirmware === true && Boolean(normalizeMacAddress(panel.macAddress)),
        nativePluginInstances: normalizeNativePluginInstances(panel.nativePluginInstances),
        panelEventPluginInstances: normalizeNativePluginInstances(panel.panelEventPluginInstances),
        settings: normalizePanelSettings(panel.settings, panel.name)
      })) : [],
      routes: Array.isArray(saved.routes) ? saved.routes : [],
      pluginProfiles: pluginProfiles.profiles,
      pluginInstances: pluginConfiguration.instances,
      panelBindings: Array.isArray(saved.panelBindings) ? saved.panelBindings : []
    };
    return {
      config,
      needsMigration: pluginConfiguration.migrated || pluginProfiles.needsMigration || brokerPassword.needsMigration ||
        bearerToken.needsMigration || httpPassword.needsMigration || credentialFormatNeedsMigration
    };
  }

  /** Produces the versioned, encrypted database representation for the current snapshot. */
  private serializeForStorage(): string {
    const persistedConfig: PersistedManagerConfig = {
      ...this.config,
      credentialEncryptionVersion: 1,
      pluginProfiles: this.config.pluginProfiles.map((profile) => profile.pluginId === "home-assistant"
        ? {
          ...profile,
          config: {
            ...profile.config,
            accessToken: this.credentialEncryption.encrypt(
              typeof profile.config["accessToken"] === "string" ? profile.config["accessToken"] as string : "",
              HOME_ASSISTANT_SECRET_PURPOSE
            ) as string | EncryptedCredential
          }
        }
        : profile),
      broker: {
        ...this.config.broker,
        password: this.credentialEncryption.encrypt(this.config.broker.password)
      },
      httpLogTransport: {
        ...this.config.httpLogTransport,
        bearerToken: this.credentialEncryption.encrypt(this.config.httpLogTransport.bearerToken, HTTP_LOG_BEARER_PURPOSE),
        password: this.credentialEncryption.encrypt(this.config.httpLogTransport.password, HTTP_LOG_PASSWORD_PURPOSE)
      }
    };
    return JSON.stringify(persistedConfig);
  }
}

const emptyConfig: ManagerConfig = {
  broker: { url: "", username: "", password: "" },
  httpLogTransport: {
    enabled: false,
    url: "",
    level: "info",
    authType: "none",
    bearerToken: "",
    username: "",
    password: ""
  },
  firmwareRollout: { enabled: false, stableHours: 3 },
  backupSettings: { enabled: true, schedule: "0 3 * * *", retentionCount: 14, directory: "backups" },
  panels: [], routes: [], pluginProfiles: [], pluginInstances: [], panelBindings: []
};

function decryptHomeAssistantTokens(profiles: PluginProfile[], credentialEncryption: CredentialEncryption): { profiles: PluginProfile[]; needsMigration: boolean } {
  let needsMigration = false;
  const decryptedProfiles = profiles.map((profile) => {
    if (profile.pluginId !== "home-assistant" || profile.config["accessToken"] === undefined) return profile;
    const token = credentialEncryption.decryptStored(profile.config["accessToken"], HOME_ASSISTANT_SECRET_PURPOSE);
    needsMigration ||= token.needsMigration;
    return { ...profile, config: { ...profile.config, accessToken: token.value } };
  });
  return { profiles: decryptedProfiles, needsMigration };
}

function normalizeBackupSettings(value: unknown): BackupSettings {
  if (!isRecord(value)) return structuredClone(emptyConfig.backupSettings);
  return {
    enabled: value.enabled !== false,
    schedule: typeof value.schedule === "string" && value.schedule.trim() ? value.schedule.trim() : emptyConfig.backupSettings.schedule,
    retentionCount: typeof value.retentionCount === "number" && Number.isInteger(value.retentionCount) && value.retentionCount >= 1
      ? Math.min(365, value.retentionCount)
      : emptyConfig.backupSettings.retentionCount,
    directory: typeof value.directory === "string" && value.directory.trim() ? value.directory.trim() : emptyConfig.backupSettings.directory
  };
}

/** Restores safe defaults for new or older configuration documents. */
function normalizeHttpLogTransportSettings(value: unknown): HttpLogTransportSettings {
  if (!isRecord(value)) return structuredClone(emptyConfig.httpLogTransport);
  const levels = ["debug", "info", "warn", "error"] as const;
  const authTypes = ["none", "bearer", "basic"] as const;
  return {
    enabled: value.enabled === true,
    url: typeof value.url === "string" ? value.url : "",
    level: levels.includes(value.level as HttpLogTransportSettings["level"])
      ? value.level as HttpLogTransportSettings["level"]
      : "info",
    authType: authTypes.includes(value.authType as HttpLogTransportSettings["authType"])
      ? value.authType as HttpLogTransportSettings["authType"]
      : "none",
    bearerToken: typeof value.bearerToken === "string" ? value.bearerToken : "",
    username: typeof value.username === "string" ? value.username : "",
    password: typeof value.password === "string" ? value.password : ""
  };
}

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
