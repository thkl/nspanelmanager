import type { Panel, PanelBinding, PluginConfigValue, PluginVariables, ResolvedPluginInstance } from "../../types.js";

/** Describes one editable setting, including optional schema-driven row tables. */
export interface PluginConfigField {
  key: string;
  label: string;
  type: "text" | "number" | "textarea" | "table";
  required?: boolean;
  defaultValue: PluginConfigValue;
  help?: string;
  columns?: readonly PluginConfigColumn[];
  minRows?: number;
  maxRows?: number;
  /** Links a table's row count to a numeric setting such as maxSpeed. */
  rowCountKey?: string;
  /** Customizes the first-column heading and row-add action in the editor. */
  rowHeader?: string;
  addRowLabel?: string;
}

/** Describes a column in a plugin-configured row table. */
export interface PluginConfigColumn {
  key: string;
  label: string;
  multiline?: boolean;
  options?: readonly string[];
  /** Supplies dropdown values from configured plugin instances in the web editor. */
  optionSource?: "plugin-instances";
}

/** Describes a value that belongs to one configured device instance. */
export interface PluginInstanceVariableField {
  key: string;
  label: string;
  required?: boolean;
  help?: string;
}

/** Firmware-native 12-button menu page shown by a plugin favorite. */
export interface PluginMenuPage {
  title: string;
  buttons: Array<{ label: string }>;
}

/** Selection from a plugin-owned menu page. */
export interface PluginMenuPageAction {
  /** Opens an enabled flow plugin instance, preserving the menu as the Back destination. */
  targetPluginInstanceId?: string;
}

/** Commands that open and refresh a firmware-native page launched as a favorite flow. */
export interface PluginFavoritePanelPageResult {
  commands?: PluginCommand[];
  statePatch?: PluginState;
}

/** Commands and optimistic state produced by pressing a directly bound favorite. */
export interface PluginFavoritePressResult {
  commands?: PluginCommand[];
  statePatch?: PluginState;
}

/** Normalized device state cached per instance and restored from the last durable runtime snapshot after restart. */
export type PluginState = Record<string, unknown>;

/** Transport metadata retained when the MQTT client dispatches a source packet. */
export interface MqttMessageEnvelope {
  topic: string;
  payload: string;
  qos: 0 | 1 | 2;
  retain: boolean;
  receivedAt: number;
}

/** One action rendered as a button on the firmware's universal info page. */
export interface PluginScreenButton {
  label: string;
  action: string;
}

/** A screen model independent of the panel's MQTT topic and JSON envelope. */
export interface PluginScreen {
  title: string;
  message: string;
  buttons: PluginScreenButton[];
}

/** A device command returned by a plugin action for the MQTT transport. */
export interface PluginCommand {
  topic: string;
  payload: string;
}

/** One callback subscription registered by a plugin's initialization script. */
export interface PluginMqttSubscription {
  topicFilter: string;
  handlerSource: string;
}

/** Result of applying a panel action to a plugin-backed device. */
export interface PluginActionResult {
  screen: string | "exit";
  statePatch?: PluginState;
  commands?: PluginCommand[];
  /** Changes how the runtime records page history for script navigation requests. */
  navigation?: PluginPageNavigation;
}

/** Navigation requested by a script action or a plugin MQTT callback. */
export interface PluginPageNavigation {
  type: "go" | "reload";
  /** Omitted only by reloadpage(), which means the current page for each panel. */
  screen?: string;
}

/** Commands and optional page navigation produced by one dynamic MQTT callback. */
export interface PluginSubscriptionResult {
  commands?: PluginCommand[];
  /** Silent plugin-state updates retained for a later page render. */
  statePatch?: PluginState;
  navigation?: PluginPageNavigation;
}

/** Result of translating input from a firmware-native page into MQTT work. */
export interface PluginNativePanelResult {
  commands?: PluginCommand[];
  /** Immediate normalized state changes, such as an optimistic target update. */
  statePatch?: PluginState;
}

/** One related plugin instance and its latest in-memory device state. */
export interface PluginNativePanelInstanceState {
  instance: ResolvedPluginInstance;
  state: PluginState;
}

/** Result of processing one home-tile action or one of its built-in detail-page events. */
export interface PluginHomeTileResult {
  commands?: PluginCommand[];
  statePatch?: PluginState;
  /** Updates the manager's page gate after a tile opens or closes a firmware page. */
  page?: "home" | "light" | "level" | "closed";
}

export type PluginStorageScope = "global" | "plugin" | "panel";

/** A panel's durable script values, addressed by its saved name or ID. */
export interface PanelStorageSnapshot {
  id: string;
  name: string;
  values: Record<string, unknown>;
}

/**
 * Capabilities passed to plugin screen and action handlers for one panel flow.
 * Scoped storage is durable, and publish delegates to the manager's shared MQTT
 * connection instead of allowing plugins to create unmanaged broker clients.
 */
export interface PluginRuntimeContext {
  panel: Pick<Panel, "id" | "name" | "nodeName">;
  binding: Pick<PanelBinding, "id" | "name" | "panelId" | "pluginInstanceId" | "trigger">;
  /** Per-instance values configured for reusable plugin scripts and templates. */
  variables: PluginVariables;
  storage: {
    get(scope: PluginStorageScope, key: string): Promise<unknown>;
    set(scope: PluginStorageScope, key: string, value: unknown): Promise<void>;
    delete(scope: PluginStorageScope, key: string): Promise<void>;
    /** Returns all values visible within a scope for synchronous script access. */
    snapshot(scope: PluginStorageScope): Promise<Record<string, unknown>>;
    /** Returns storage for every saved panel so scripts can address one by name. */
    snapshotPanels(): Promise<PanelStorageSnapshot[]>;
    /** Writes to one panel's durable store using its saved name or ID. */
    setPanel(panelNameOrId: string, key: string, value: unknown): Promise<void>;
    /** Deletes a key from one panel's durable store using its saved name or ID. */
    deletePanel(panelNameOrId: string, key: string): Promise<void>;
  };
  publish(topic: string, payload: string): boolean;
  /** Writes a script diagnostic to the manager log or the preview response. */
  debug: { log(message: string): void };
}

/**
 * Defines the reusable runtime contract for a device or service integration.
 * Implementations normalize incoming state in memory and map panel actions to
 * commands; the manager owns MQTT connections, explicit scoped persistence,
 * and panel transport.
 */
export interface PluginDefinition {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly description: string;
  readonly capabilities: readonly string[];
  /** Whether the integration can be opened from a panel favorite or menu shortcut. */
  readonly favoriteFlow?: boolean;
  /** Firmware-native detail page used by this favorite flow, when applicable. */
  readonly favoritePanelPage?: "level";
  /** Native firmware page ID this integration can serve, such as `thermostat`. */
  readonly nativePanelPage?: string;
  /** Allows same-type instances to share one native page and receive its events. */
  readonly nativePanelSharedInstances?: boolean;
  /** Allows a native page integration to publish state while its page is closed. */
  readonly nativePanelStateUpdatesWhenClosed?: boolean;
  /** Whether this plugin can be assigned to observe all page-change events for a panel. */
  readonly panelEventObserver?: boolean;
  /** Per-instance fields shown in the reusable instance editor. */
  readonly instanceVariableFields?: readonly PluginInstanceVariableField[];
  /** Device capability exposed to the four configurable panel home tiles. */
  readonly homeTileType?: "light" | "cover";
  readonly configSchema: readonly PluginConfigField[];

  /** Returns an error message when reusable plugin configuration is incomplete. */
  validateConfig(config: Record<string, PluginConfigValue>): string | undefined;
  /** Validates per-instance variables after profile configuration is resolved. */
  validateInstance?(instance: ResolvedPluginInstance): string | undefined;
  /** Lists incoming MQTT filters for the configured instance. */
  subscriptions(instance: ResolvedPluginInstance): readonly string[];
  /** Runs once per broker connection with all enabled instances of this plugin. */
  onMqttConnected?(instances: readonly ResolvedPluginInstance[], publish: (topic: string, payload: string) => boolean): void | Promise<void>;
  /** Selects the configured instance or instances that should receive a shared native-page event. */
  nativePanelEventTargets?(instances: readonly ResolvedPluginInstance[], panel: Panel, message: MqttMessageEnvelope): readonly ResolvedPluginInstance[] | undefined;
  /** Runs when an enabled instance starts or its configuration changes. */
  initialize?(instance: ResolvedPluginInstance, state: PluginState, context: PluginRuntimeContext): Promise<readonly PluginMqttSubscription[]>;
  /** Executes a registered callback for one MQTT message and may return commands or page navigation. */
  handleSubscription?(instance: ResolvedPluginInstance, subscription: PluginMqttSubscription, message: MqttMessageEnvelope, state: PluginState, context: PluginRuntimeContext): Promise<PluginSubscriptionResult | void>;
  /** Converts a matching MQTT payload into a partial normalized state update. */
  decodeMessage(instance: ResolvedPluginInstance, message: MqttMessageEnvelope, currentState?: PluginState): PluginState | undefined;
  /** Selects normalized state values to expose through the instance's durable `plugin.get` store. */
  scriptStorageValues?(instance: ResolvedPluginInstance, state: PluginState): Record<string, unknown>;
  /** Returns the page to open for a favorite binding, defaulting to overview. */
  startScreen?(instance: ResolvedPluginInstance): string;
  /** Builds a display model for the requested flow screen. */
  renderScreen(instance: ResolvedPluginInstance, state: PluginState, screen: string, context: PluginRuntimeContext): PluginScreen | void | Promise<PluginScreen | void>;
  /** Builds a firmware-native 12-button menu page for the active favorite flow. */
  renderMenuPage?(instance: ResolvedPluginInstance, context: PluginRuntimeContext): PluginMenuPage | void | Promise<PluginMenuPage | void>;
  /** Reports whether a directly assigned favorite should show its active indicator. */
  favoriteStateActive?(instance: ResolvedPluginInstance, state: PluginState, context: PluginRuntimeContext): boolean | undefined | Promise<boolean | undefined>;
  /** Handles a directly bound favorite press without opening a plugin screen. */
  handleFavoritePress?(instance: ResolvedPluginInstance, panel: Panel, binding: PanelBinding, state: PluginState, context: PluginRuntimeContext): PluginFavoritePressResult | void | Promise<PluginFavoritePressResult | void>;
  /** Maps a native menu selection to a configured plugin instance to open. */
  handleMenuPageAction?(instance: ResolvedPluginInstance, index: number, context: PluginRuntimeContext): PluginMenuPageAction | void | Promise<PluginMenuPageAction | void>;
  /** Opens a native favorite page, including its page navigation and initial configuration. */
  openFavoritePanelPage?(instance: ResolvedPluginInstance, panel: Panel, binding: PanelBinding, state: PluginState): PluginFavoritePanelPageResult | Promise<PluginFavoritePanelPageResult>;
  /** Handles query and control messages from a native favorite page. */
  handleFavoritePanelEvent?(instance: ResolvedPluginInstance, panel: Panel, binding: PanelBinding, message: MqttMessageEnvelope, state: PluginState): PluginFavoritePanelPageResult | void | Promise<PluginFavoritePanelPageResult | void>;
  /** Refreshes a native favorite page with changed device state while it is visible. */
  renderFavoritePanelState?(instance: ResolvedPluginInstance, panel: Panel, state: PluginState): readonly PluginCommand[];
  /** Maps a panel action to commands and an optional optimistic state update. */
  handleAction(instance: ResolvedPluginInstance, state: PluginState, action: string, context: PluginRuntimeContext): PluginActionResult | Promise<PluginActionResult>;
  /** Reports whether one panel MQTT event opens or closes this native page. */
  nativePanelTransition?(instance: ResolvedPluginInstance, panel: Panel, message: MqttMessageEnvelope): "open" | "close" | undefined;
  /** Handles one native page event, such as a thermostat setpoint or mode button. */
  handleNativePanelEvent?(instance: ResolvedPluginInstance, panel: Panel, message: MqttMessageEnvelope, state: PluginState, relatedInstances?: readonly ResolvedPluginInstance[]): PluginNativePanelResult | void | Promise<PluginNativePanelResult | void>;
  /** Handles a panel event independently of native-page ownership, such as a page-change dimmer rule. */
  handlePanelEvent?(instance: ResolvedPluginInstance, panel: Panel, message: MqttMessageEnvelope): readonly PluginCommand[] | void | Promise<readonly PluginCommand[] | void>;
  /** Converts normalized device state to firmware commands while its native page is open. */
  renderNativePanelState?(instance: ResolvedPluginInstance, panel: Panel, state: PluginState, relatedInstances?: readonly PluginNativePanelInstanceState[]): readonly PluginCommand[];
  /** Converts changed plugin state to panel commands that remain useful off-page, such as a home-screen temperature. */
  renderPanelState?(instance: ResolvedPluginInstance, panel: Panel, state: PluginState, previousState: PluginState, change: PluginState): readonly PluginCommand[];
  /** Handles a bound home tile, the built-in light page, or the level page's MQTT events. */
  handleHomeTileEvent?(instance: ResolvedPluginInstance, panel: Panel, index: number, button: Panel["settings"]["buttons"][number], message: MqttMessageEnvelope, state: PluginState, context: PluginRuntimeContext): PluginHomeTileResult | void | Promise<PluginHomeTileResult | void>;
  /** Renders current device state to an active home tile or its built-in detail page. */
  renderHomeTileState?(instance: ResolvedPluginInstance, panel: Panel, index: number, button: Panel["settings"]["buttons"][number], page: "home" | "light" | "level", state: PluginState): readonly PluginCommand[];
  /** Returns the configured interval for a service plugin's scheduled state refresh. */
  pollIntervalMs?(instance: ResolvedPluginInstance): number;
  /** Fetches external service state; the runtime caches the patch and routes it to assigned panels. */
  poll?(instance: ResolvedPluginInstance, state: PluginState): Promise<PluginState | void>;
}

/** Reads a typed value from plugin configuration, returning a safe fallback. */
export function configString(instance: ResolvedPluginInstance, key: string, fallback = ""): string {
  const value = instance.config[key];
  return typeof value === "string" ? value : fallback;
}

/** Reads a positive finite numeric plugin setting, returning a safe fallback. */
export function configNumber(instance: ResolvedPluginInstance, key: string, fallback: number): number {
  const value = instance.config[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
