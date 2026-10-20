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
  settings: PanelSettings;
  /** Reusable plugin instances assigned to firmware-native pages by page ID. */
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
