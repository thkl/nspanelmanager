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
  buttons: MainButton[];
  favorites: { name: string; buttons: FavoriteButton[] };
  hwbuttons: { "0": number; "1": number };
  music?: Array<{ id: string; name: string; sonos?: string; player?: string; currentSong?: string }>;
}

export interface Panel {
  id: string;
  name: string;
  nodeName: string;
  settings: PanelSettings;
  nativePluginInstances?: Record<string, string>;
  panelEventPluginInstances?: Record<string, string>;
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
  type: "text" | "number" | "textarea" | "table";
  required?: boolean;
  defaultValue: PluginConfigValue;
  help?: string;
  columns?: PluginConfigColumn[];
  minRows?: number;
  maxRows?: number;
  rowCountKey?: string;
  rowHeader?: string;
  addRowLabel?: string;
}

export interface PluginConfigColumn {
  key: string;
  label: string;
  multiline?: boolean;
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
  panelEventObserver?: boolean;
  instanceVariableFields?: Array<{ key: string; label: string; required?: boolean; help?: string }>;
  homeTileType?: "light" | "cover";
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

/** Current online state reported by one configured NSPanel over MQTT. */
export interface PanelResetReport {
  reason: string;
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
}

export interface PanelConnectionStatus {
  panelId: string;
  nodeName: string;
  status: "online" | "offline";
  lastSeenAt: number | null;
  lastResetReport: PanelResetReport | null;
  telemetry: PanelTelemetry | null;
}

/** Metadata for the latest Nextion HMI artifact uploaded to the manager. */
export interface HmiArtifact {
  id: string;
  filename: string;
  size: number;
  sha256: string;
  uploadedAt: string;
}

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
