export interface MainButton {
  label: string;
  /** HMI icon ID: 0 lamp, 1 bulb, 2 downlight, 3 desk lamp, 4 outdoor lamp, 5 blind, 6 curtain. */
  image: string;
  /** Firmware tile mode: 0 up/down and toggle, 1 level page, 2 toggle only. */
  mode: number;
  /** Manager-only device instance assigned to this home-screen tile. */
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
  /** Stable hardware identity reported by ESPHome MQTT discovery. */
  macAddress?: string;
  /** Set after this profile is detected on the unified, MAC-addressed firmware topic. */
  unifiedFirmware?: boolean;
  settings: PanelSettings;
  /** Reusable plugin instances assigned to firmware-native pages by page ID. */
  nativePluginInstances?: Record<string, string>;
  /** Reusable plugin instances that observe every firmware page-change event, keyed by plugin ID. */
  panelEventPluginInstances?: Record<string, string>;
}

/** Recently discovered ESPHome device awaiting a manager panel assignment. */
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

/** Latest reboot reason reported by one panel, with the manager's receipt time. */
export interface PanelResetReport {
  reason: string;
  /** Time the manager received the diagnostic reply, not the time of the reboot. */
  reportedAt: number;
}

/** Latest firmware diagnostics included in a panel's MQTT heartbeat. */
export interface PanelTelemetry {
  /** Time the manager received this telemetry report. */
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

/** Live MQTT connectivity, telemetry, and latest reboot report for one panel. */
export interface PanelConnectionStatus {
  panelId: string;
  nodeName: string;
  status: "online" | "offline";
  lastSeenAt: number | null;
  lastResetReport: PanelResetReport | null;
  telemetry: PanelTelemetry | null;
}

/** Metadata returned by the authenticated HMI upload and status endpoints. */
export interface HmiArtifactRecord {
  id: string;
  filename: string;
  size: number;
  sha256: string;
  uploadedAt: string;
}

export type HmiUpdateJobStatus = "sending" | "sent" | "awaiting_confirmation" | "uploading" | "succeeded" | "failed" | "cancelled" | "timed_out";

/** Durable record of one HMI update attempt for a configured panel. */
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

/** Metadata for the latest ESPHome OTA binary uploaded to the manager. */
export interface FirmwareArtifactRecord {
  id: string;
  filename: string;
  version: string;
  size: number;
  md5: string;
  sha256: string;
  uploadedAt: string;
}

export type FirmwareUpdateJobStatus = "sending" | "sent" | "awaiting_confirmation" | "uploading" | "rebooting" | "succeeded" | "failed" | "cancelled" | "timed_out";

/** Durable record of one manager-delivered firmware update attempt. */
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

/** A validated, user-configured instance of a registered runtime plugin. */
export interface PluginInstance {
  id: string;
  name: string;
  pluginProfileId: string;
  enabled: boolean;
  /** Per-instance values available to the referenced plugin's scripts and templates. */
  variables: PluginVariables;
}

/** Saved reusable plugin configuration, independent of any panel assignment. */
export interface PluginProfile {
  id: string;
  name: string;
  pluginId: string;
  config: Record<string, PluginConfigValue>;
}

/** Instance reference combined with its profile data for plugin runtime calls. */
export interface ResolvedPluginInstance extends PluginInstance {
  pluginId: string;
  config: Record<string, PluginConfigValue>;
}

/** Connects one plugin instance to a favorite shortcut on a specific panel. */
export interface PanelBinding {
  id: string;
  name: string;
  panelId: string;
  pluginInstanceId: string;
  trigger: { type: "favorite"; index: number };
}

export interface BrokerSettings {
  url: string;
  username: string;
  password: string;
}

export interface ManagerConfig {
  broker: BrokerSettings;
  panels: Panel[];
  routes: MqttRoute[];
  pluginProfiles: PluginProfile[];
  pluginInstances: PluginInstance[];
  panelBindings: PanelBinding[];
}

export interface PublicConfig extends Omit<ManagerConfig, "broker"> {
  broker: Omit<BrokerSettings, "password"> & { passwordConfigured: boolean };
}

export function defaultPanelSettings(name = "New NSPanel"): PanelSettings {
  return {
    panelname: name,
    brightness: 100,
    screensaver: 0,
    nightmode: 0,
    buttons: Array.from({ length: 4 }, () => ({ label: "", image: "1", mode: 0 })),
    favorites: {
      name: "Favorites",
      buttons: Array.from({ length: 12 }, () => ({ label: "" }))
    },
    hwbuttons: { "0": 0, "1": 0 }
  };
}
