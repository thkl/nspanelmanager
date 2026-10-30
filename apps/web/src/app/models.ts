/** Presentation and API shapes used by the manager's feature pages. */
export interface MainButton {
  label: string;
  image: string;
  mode: number;
  pluginInstanceId?: string;
}

export interface FavoriteButton {
  label: string;
  mode?: number;
}

export interface PanelSettings {
  panelname: string;
  currenttemperature?: number;
  brightness?: number;
  screensaver?: number;
  roomstatus?: number;
  nightmode?: number;
  touchClick?: boolean;
  buttons: MainButton[];
  favorites: { name: string; buttons: FavoriteButton[] };
  hwbuttons: { "0": number; "1": number };
  music?: Array<{ id: string; name: string; sonos?: string; player?: string; currentSong?: string }>;
}

export interface Panel {
  id: string;
  name: string;
  nodeName: string;
  macAddress?: string;
  groupName?: string;
  unifiedFirmware?: boolean;
  settings: PanelSettings;
  nativePluginInstances?: Record<string, string>;
  panelEventPluginInstances?: Record<string, string>;
  hardwareButtonPluginInstances?: Partial<Record<"0" | "1", string>>;
  autoUpdateFirmware?: boolean;
  healthNotificationsEnabled?: boolean;
}

export interface FirmwareRolloutSettings {
  enabled: boolean;
  stableHours: number;
}

export interface BackupSettings {
  enabled: boolean;
  schedule: string;
  retentionCount: number;
  directory: string;
}

/** Metadata for an administrator-created or system-created configuration snapshot. */
export interface ConfigRevision {
  id: number;
  createdAt: string;
  actor: string;
  summary: string;
}

export type ConfigRevisionScopeType = "panel" | "plugin-profile" | "plugin-instance";

/** A selectable, non-secret configuration object found in a saved revision. */
export interface ConfigRevisionScopeTarget {
  id: string;
  name: string;
  details?: string;
}

/** Objects that can be restored individually from a full configuration snapshot. */
export interface ConfigRevisionScopes {
  panels: ConfigRevisionScopeTarget[];
  pluginProfiles: ConfigRevisionScopeTarget[];
  pluginInstances: ConfigRevisionScopeTarget[];
}

export type FirmwareRolloutStatus = "monitoring" | "updating" | "completed" | "failed" | "cancelled";

export interface FirmwareRollout {
  id: string;
  artifactId: string;
  firmwareVersion: string;
  canaryPanelId: string;
  canaryPanelName: string;
  startedAt: number;
  updatedAt: number;
  stableHours: number;
  status: FirmwareRolloutStatus;
  canaryConfirmed: boolean;
  pendingPanelIds: string[];
  currentPanelId?: string;
  stableSinceAt?: number;
  lastHeartbeatAt?: number;
  lastUptimeSeconds?: number;
  message: string;
}

export interface DiscoveredPanel {
  macAddress: string;
  name: string;
  friendlyName?: string;
  version?: string;
  ip?: string;
  platform?: string;
  board?: string;
  network?: string;
  lastSeenAt: number;
}

export type RouteDirection = "external-to-panel" | "panel-to-external";

export type RoutePayloadFilter =
  | { mode: "contains" | "equals"; value: string }
  | { mode: "json-equals"; path: string; value: string };

export interface MqttRoute {
  id: string;
  name: string;
  direction: RouteDirection;
  panelId?: string;
  sourceTopic: string;
  targetTopic: string;
  payloadTemplate: string;
  payloadFilter?: RoutePayloadFilter;
}

export type PluginConfigValue = string | number | boolean;
export type PluginVariables = Record<string, string>;

export interface PluginConfigField {
  key: string;
  label: string;
  type: "text" | "number" | "textarea" | "table" | "checkbox" | "password";
  required?: boolean;
  secret?: boolean;
  defaultValue: PluginConfigValue;
  help?: string;
  columns?: PluginConfigColumn[];
  minRows?: number;
  maxRows?: number;
  rowCountKey?: string;
  rowHeader?: string;
  addRowLabel?: string;
  /** Clears row cells instead of deleting the row, preserving fixed shortcut positions. */
  removeRowBehavior?: "delete" | "clear";
}

export interface PluginConfigColumn {
  key: string;
  label: string;
  multiline?: boolean;
  /** Moves this column's editor into a row-settings dialog in the web editor. */
  editInDialog?: boolean;
  options?: string[];
  optionSource?: "plugin-instances";
}

export interface PluginDefinition {
  id: string;
  name: string;
  version: number;
  description: string;
  capabilities: string[];
  favoriteFlow?: boolean;
  favoritePanelPage?: "level";
  aliases?: string[];
  nativePanelPage?: string;
  nativePanelSharedInstances?: boolean;
  nativePanelStateUpdatesWhenClosed?: boolean;
  supportsPanelStateReplay?: boolean;
  panelEventObserver?: boolean;
  instanceVariableFields?: Array<{ key: string; label: string; required?: boolean; help?: string; optionSource?: "home-assistant-entities" }>;
  homeTileType?: "light" | "cover";
  homeTileSupportsLevelPage?: boolean;
  homeTileTypeByEntityDomain?: Record<string, "light" | "cover">;
  configSchema: PluginConfigField[];
}

export interface PluginInstance {
  id: string;
  name: string;
  pluginProfileId: string;
  enabled: boolean;
  variables: PluginVariables;
}

export interface PluginProfile {
  id: string;
  name: string;
  pluginId: string;
  config: Record<string, PluginConfigValue>;
  configuredSecrets?: string[];
}

/** Schema validation and conflict details returned before a plugin blueprint is imported. */
export interface PluginBlueprintPreview {
  pluginId: string;
  pluginName: string;
  pluginVersion: number;
  profileName: string;
  profileNameConflict: boolean;
  instanceName: string;
  instanceNameConflict: boolean;
  hasInstanceTemplate: boolean;
  omittedSecrets: string[];
  missingSecrets: string[];
  warnings: string[];
}

/** Validated, portable profile data selected for import. */
export interface PluginBlueprintImportDraft {
  blueprint: unknown;
  profileName: string;
  includeInstance: boolean;
  instanceName: string;
}

export interface PluginInstanceActivity {
  instanceId: string;
  status: "waiting" | "active" | "error";
  lastActivityAt?: number;
  lastError?: string;
  lastErrorAt?: number;
}

export interface HomeAssistantEntityOption {
  entityId: string;
  name: string;
  state: string;
  domain: string;
  areaId?: string;
  areaName?: string;
}

export interface HomeAssistantAreaOption {
  id: string;
  name: string;
}

export interface HomeAssistantEntityOptions {
  entities: HomeAssistantEntityOption[];
  areas: HomeAssistantAreaOption[];
  areasAvailable: boolean;
}

export interface PanelBinding {
  id: string;
  name: string;
  panelId: string;
  pluginInstanceId: string;
  trigger: { type: "favorite"; index: number };
}

export interface ManagerConfig {
  broker: { url: string; username: string; passwordConfigured: boolean };
  firmwareRollout: FirmwareRolloutSettings;
  backupSettings: BackupSettings;
  panels: Panel[];
  routes: MqttRoute[];
  pluginProfiles: PluginProfile[];
  pluginInstances: PluginInstance[];
  panelBindings: PanelBinding[];
}

export interface MqttStatus {
  connected: boolean;
  error: string;
}

/** Latest reset reason and the time the manager received its diagnostic reply. */
export interface PanelResetReport {
  reason: string;
  /** Receipt time for the diagnostic reply; use panel uptime to estimate reboot time. */
  reportedAt: number;
}

export interface PanelTelemetry {
  reportedAt: number;
  firmwareVersion?: string;
  /** SHA-256 identifier of the last manager-delivered HMI reported after display reconnect. */
  hmiVersion?: string;
  uptimeSeconds?: number;
  freeHeapBytes?: number;
  minFreeHeapBytes?: number;
  largestFreeBlockBytes?: number;
  loopTimeMs?: number;
  chipTemperatureC?: number;
  supportsGroupSettingsAck?: boolean;
}

export type PanelGroupSettingsDelivery = "not_sent" | "pending" | "applied" | "timed_out" | "unconfirmed" | "publish_failed" | "failed";

export interface PanelGroupSettingsStatus {
  groupName: string;
  night?: 0 | 1;
  brightness?: number;
  delivery: PanelGroupSettingsDelivery;
  requestId?: string;
  requestedAt?: number;
  acknowledgedAt?: number;
}

export interface PanelConnectionStatus {
  panelId: string;
  nodeName: string;
  ip?: string;
  status: "online" | "offline";
  offlineAlertSuppressed?: boolean;
  lastSeenAt: number | null;
  lastResetReport: PanelResetReport | null;
  telemetry: PanelTelemetry | null;
  groupSettings?: PanelGroupSettingsStatus;
}

/** Metadata for the latest Nextion HMI artifact uploaded to the manager. */
export interface HmiArtifact {
  id: string;
  filename: string;
  size: number;
  sha256: string;
  uploadedAt: string;
  compatibleProfiles: HmiCompatibilityProfile[];
}

export type HmiCompatibilityProfile = "legacy" | "unified";

export type HmiRolloutStatus = "updating" | "completed" | "failed" | "cancelled";

export interface HmiRollout {
  id: string;
  artifactId: string;
  hmiVersion: string;
  canaryPanelId: string;
  canaryPanelName: string;
  currentPanelId?: string;
  currentJobId?: string;
  pendingPanelIds: string[];
  force: boolean;
  status: HmiRolloutStatus;
  startedAt: number;
  updatedAt: number;
  message: string;
}

export type HmiUpdateJobStatus = "sending" | "sent" | "awaiting_confirmation" | "uploading" | "succeeded" | "failed" | "cancelled" | "timed_out";

export interface HmiUpdateJob {
  id: string;
  panelId: string;
  panelName: string;
  nodeName: string;
  artifactId: string;
  filename: string;
  hmiVersion: string;
  status: HmiUpdateJobStatus;
  force: boolean;
  requestedAt: number;
  updatedAt: number;
  expiresAt: number;
  message?: string;
  requestedBy?: string;
}

export interface FirmwareArtifact {
  id: string;
  filename: string;
  version: string;
  size: number;
  md5: string;
  sha256: string;
  uploadedAt: string;
}

/** Metadata for the latest crash dump retained by the manager for a panel. */
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

export type FirmwareUpdateJobStatus = "sending" | "sent" | "awaiting_confirmation" | "uploading" | "rebooting" | "succeeded" | "failed" | "cancelled" | "timed_out";

export interface FirmwareUpdateJob {
  id: string;
  panelId: string;
  panelName: string;
  nodeName: string;
  artifactId: string;
  filename: string;
  firmwareVersion: string;
  status: FirmwareUpdateJobStatus;
  force: boolean;
  requestedAt: number;
  updatedAt: number;
  expiresAt: number;
  progress?: number;
  message?: string;
  requestedBy?: string;
}

export type ManagerRealtimeEvent =
  | { type: "snapshot"; panels: PanelConnectionStatus[]; discoveredPanels: DiscoveredPanel[]; pluginActivities: PluginInstanceActivity[]; hmiJobs: HmiUpdateJob[]; hmiRollout: HmiRollout | null; firmwareJobs: FirmwareUpdateJob[]; firmwareRollout: FirmwareRollout | null; mqtt: MqttStatus }
  | { type: "panels"; panels: PanelConnectionStatus[] }
  | { type: "discovered-panels"; panels: DiscoveredPanel[] }
  | { type: "plugin-activity"; activity: PluginInstanceActivity }
  | { type: "hmi-job"; job: HmiUpdateJob }
  | { type: "hmi-rollout"; rollout: HmiRollout | null }
  | { type: "firmware-job"; job: FirmwareUpdateJob }
  | { type: "firmware-rollout"; rollout: FirmwareRollout | null }
  | { type: "core-dump"; dump: CoreDumpRecord }
  | { type: "mqtt"; mqtt: MqttStatus };

export interface ManagerState {
  config: ManagerConfig;
  mqtt: MqttStatus;
}

export interface AuthUser {
  id: string;
  email: string;
  enabled: boolean;
  createdAt: string;
  ssoLinked: boolean;
}

export interface AuthStatus {
  authenticated: boolean;
  user?: AuthUser;
  ssoEnabled: boolean;
  hasUsers: boolean;
}

export interface BrokerInput {
  url: string;
  username: string;
  password: string;
}

export interface RouteDraft {
  name: string;
  direction: RouteDirection;
  panelId: string;
  sourceTopic: string;
  targetTopic: string;
  payloadTemplate: string;
  payloadFilter: { mode: "none" | "contains" | "equals" | "json-equals"; path: string; value: string };
}

export interface PluginInstanceDraft {
  name: string;
  pluginProfileId: string;
  enabled: boolean;
  variables: PluginVariables;
}

export interface PluginProfileDraft {
  name: string;
  pluginId: string;
  config: Record<string, PluginConfigValue>;
}

export interface PluginPagePreviewInput {
  pluginId: string;
  config: Record<string, PluginConfigValue>;
  variables: PluginVariables;
  pageId: string;
  topic: string;
  payload: string;
  /** Optional one-based button slot to simulate after decoding the sample message. */
  actionSlot?: number;
}

export interface PluginPagePreviewResult {
  pageId: string;
  rendered: boolean;
  title: string;
  message: string;
  buttons: string[];
  /** Commands produced by a simulated action; none have been published. */
  commands?: Array<{ topic: string; payload: string }>;
  debugLogs: string[];
}

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Structured application log record shown in the admin log viewer. */
export interface AdminLogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  category: string;
  context: Record<string, string>;
}

/** Bounded log response returned from retained rotating files. */
export interface AdminLogResult {
  logs: AdminLogEntry[];
  categories: string[];
  hasMore: boolean;
  scanLimitReached: boolean;
}

export interface PluginScriptCheckResult {
  valid: boolean;
  error?: string;
}

export interface PanelBindingDraft {
  name: string;
  panelId: string;
  pluginInstanceId: string;
  favoriteIndex: number;
}
