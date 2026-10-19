/** Presentation and API shapes used by the manager's feature pages. */
export interface MainButton {
  label: string;
  image: string;
  mode: number;
  labelvalue?: string;
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
}

export interface Panel {
  id: string;
  name: string;
  nodeName: string;
  settings: PanelSettings;
  nativePluginInstances?: Record<string, string>;
}

export type RouteDirection = "external-to-panel" | "panel-to-external";

export interface MqttRoute {
  id: string;
  name: string;
  direction: RouteDirection;
  panelId?: string;
  sourceTopic: string;
  targetTopic: string;
  payloadTemplate: string;
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
}

export interface PluginDefinition {
  id: string;
  name: string;
  version: number;
  description: string;
  capabilities: string[];
  nativePanelPage?: string;
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
}

export interface PluginPagePreviewResult {
  pageId: string;
  rendered: boolean;
  title: string;
  message: string;
  buttons: string[];
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
