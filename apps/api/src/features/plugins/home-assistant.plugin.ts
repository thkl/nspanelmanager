import type { Panel, PanelBinding, PluginConfigValue, ResolvedPluginInstance } from "../../types.js";
import { Logger } from "../../services/logger.js";
import type {
  MqttMessageEnvelope,
  PluginActionResult,
  PluginConfigField,
  PluginDefinition,
  PluginFavoritePanelPageResult,
  PluginFavoritePressResult,
  PluginHomeTileResult,
  PluginRuntimeContext,
  PluginScreen,
  PluginState
} from "./plugin-contract.js";
import { configNumber } from "./plugin-contract.js";
import {
  entityDomain,
  entityStatePatch,
  getHomeAssistantEntity,
  isSupportedEntityId,
  numberValue,
  requiredEntityId,
  stringValue,
  validHomeAssistantBaseUrl
} from "./home-assistant/home-assistant.api.js";
import { HomeAssistantCoverControls } from "./home-assistant/home-assistant.cover.js";
import { HomeAssistantLightControls } from "./home-assistant/home-assistant.light.js";
import { HomeAssistantSwitchControls } from "./home-assistant/home-assistant.switch.js";
import { HomeAssistantVacuumControls } from "./home-assistant/home-assistant.vacuum.js";

export { fetchHomeAssistantEntityOptions } from "./home-assistant/home-assistant.api.js";
export type { HomeAssistantEntityOption, HomeAssistantEntityOptions } from "./home-assistant/home-assistant.api.js";

/**
 * Registers Home Assistant as a manager plugin and connects plugin lifecycle
 * hooks to the focused switch, light, cover, vacuum, and API modules.
 *
 * Flow overview:
 * 1. The saved profile supplies the HA URL and access token.
 * 2. Each instance selects one HA entity by entity ID.
 * 3. Polling refreshes normalized state; user actions are delegated by domain.
 * 4. Domain modules return state patches and panel commands to the MQTT runtime.
 */
export class HomeAssistantPlugin implements PluginDefinition {
  readonly id = "home-assistant";
  readonly name = "Home Assistant";
  readonly version = 2;
  readonly description = "Select Home Assistant devices for toggle, color-light, cover-level, or vacuum controls.";
  readonly capabilities = ["home-assistant", "favorite-toggle", "favorite-page", "home-tile"];
  readonly favoriteFlow = true;
  readonly homeTileTypeByEntityDomain = { light: "light", cover: "cover" } as const;
  readonly homeTileSupportsLevelPage = true;
  readonly instanceVariableFields = [
    {
      key: "entityId",
      label: "Home Assistant entity",
      required: true,
      help: "Choose a supported light, cover, vacuum, switch, fan, or media player.",
      optionSource: "home-assistant-entities"
    }
  ] as const;
  readonly configSchema: readonly PluginConfigField[] = [
    {
      key: "baseUrl",
      label: "Home Assistant URL",
      type: "text",
      required: true,
      defaultValue: "http://homeassistant.local:8123",
      help: "Manager-reachable Home Assistant base URL, including its scheme and port."
    },
    {
      key: "accessToken",
      label: "Long-lived access token",
      type: "password",
      required: true,
      secret: true,
      defaultValue: "",
      help: "Create a Home Assistant long-lived access token. Leave blank when editing to keep the saved token."
    },
    {
      key: "pollSeconds",
      label: "State refresh interval (seconds)",
      type: "number",
      required: true,
      defaultValue: 60,
      help: "How often the manager checks the selected entity for state changes (15–3,600 seconds)."
    },
    {
      key: "lightBrightnessStep",
      label: "Light dimming step (%)",
      type: "number",
      defaultValue: 10,
      help: "Brightness change for each Up or Down action on a light tile."
    },
    {
      key: "lightOnBrightness",
      label: "Turn-on light brightness (%)",
      type: "number",
      defaultValue: 50,
      help: "Brightness sent when turning on a light from off or zero brightness."
    },
    {
      key: "coverPositionStep",
      label: "Cover position step (%)",
      type: "number",
      defaultValue: 10,
      help: "Position change for each Up or Down action on a cover tile."
    },
    {
      key: "lightPreset1Rgb",
      label: "Light color preset 1 (hex)",
      type: "text",
      defaultValue: "#ffffff",
      help: "Color used by the first preset button on the panel color page."
    },
    {
      key: "lightPreset2Rgb",
      label: "Light color preset 2 (hex)",
      type: "text",
      defaultValue: "#ffb35c",
      help: "Color used by the second preset button on the panel color page."
    },
    {
      key: "lightPresetBrightness",
      label: "Preset brightness (%)",
      type: "number",
      defaultValue: 100,
      help: "Brightness applied when either color preset is selected."
    }
  ];

  private readonly switchControls = new HomeAssistantSwitchControls();
  private readonly lightControls = new HomeAssistantLightControls();
  private readonly coverControls = new HomeAssistantCoverControls();
  private readonly vacuumControls: HomeAssistantVacuumControls;

  /** Builds Home Assistant controllers with the manager's structured logger. */
  constructor(logger: Logger = new Logger()) {
    this.vacuumControls = new HomeAssistantVacuumControls(logger);
  }

  /** Validates the HA connection, refresh interval, and device-control options. */
  validateConfig(config: Record<string, PluginConfigValue>): string | undefined {
    if (!validHomeAssistantBaseUrl(stringValue(config, "baseUrl"))) {
      return "Enter a valid Home Assistant HTTP or HTTPS base URL without credentials, query parameters, or a fragment.";
    }
    if (!stringValue(config, "accessToken").trim()) {
      return "Enter a Home Assistant long-lived access token.";
    }

    const pollSeconds = numberValue(config, "pollSeconds");
    if (pollSeconds === undefined || !Number.isInteger(pollSeconds) || pollSeconds < 15 || pollSeconds > 3600) {
      return "State refresh interval must be a whole number between 15 and 3,600 seconds.";
    }
    for (const [key, defaultValue] of [["lightBrightnessStep", 10], ["coverPositionStep", 10]] as const) {
      const step = numberValue(config, key) ?? defaultValue;
      if (step <= 0 || step > 100) {
        return "Light and cover steps must be greater than 0 and no more than 100 percent.";
      }
    }
    const lightOnBrightness = numberValue(config, "lightOnBrightness") ?? 50;
    if (lightOnBrightness < 1 || lightOnBrightness > 100) {
      return "Turn-on light brightness must be between 1 and 100 percent.";
    }
    for (const [key, fallback] of [["lightPreset1Rgb", "#ffffff"], ["lightPreset2Rgb", "#ffb35c"]] as const) {
      const value = stringValue(config, key) || fallback;
      if (!/^#?[0-9a-f]{6}$/i.test(value)) {
        return "Light color presets must be six-digit hexadecimal RGB colors.";
      }
    }
    const presetBrightness = numberValue(config, "lightPresetBrightness") ?? 100;
    if (presetBrightness < 1 || presetBrightness > 100) {
      return "Preset brightness must be between 1 and 100 percent.";
    }
    return undefined;
  }

  /** Requires each plugin instance to refer to a supported HA entity ID. */
  validateInstance(instance: ResolvedPluginInstance): string | undefined {
    if (!isSupportedEntityId(instance.variables.entityId)) {
      return "Choose a supported Home Assistant light, cover, vacuum, switch, fan, or media player.";
    }
    return undefined;
  }

  /** Selects the panel tile type for Home Assistant lights and covers only. */
  homeTileTypeForInstance(instance: ResolvedPluginInstance): "light" | "cover" | undefined {
    const domain = entityDomain(instance.variables.entityId);
    if (domain === "light") return "light";
    if (domain === "cover") return "cover";
    return undefined;
  }

  /** HA lights and covers can both use the firmware's native level page. */
  supportsHomeTileLevelPage(instance: ResolvedPluginInstance): boolean {
    const domain = entityDomain(instance.variables.entityId);
    return domain === "light" || domain === "cover";
  }

  /** Sends a cover favorite to the panel's native level page on long press. */
  favoritePanelPageForInstance(instance: ResolvedPluginInstance): "level" | undefined {
    return entityDomain(instance.variables.entityId) === "cover" ? "level" : undefined;
  }

  /** This integration uses HA polling and does not subscribe to MQTT topics. */
  subscriptions(_instance: ResolvedPluginInstance): readonly string[] {
    return [];
  }

  /** HA polling supplies state, so there are no plugin MQTT payloads to decode. */
  decodeMessage(_instance: ResolvedPluginInstance, _message: MqttMessageEnvelope): PluginState | undefined {
    return undefined;
  }

  /** Returns the profile's state refresh interval in milliseconds. */
  pollIntervalMs(instance: ResolvedPluginInstance): number {
    return configNumber(instance, "pollSeconds", 60) * 1000;
  }

  /** Polls HA and returns only values that differ from the cached plugin state. */
  async poll(instance: ResolvedPluginInstance, state: PluginState): Promise<PluginState | undefined> {
    const entity = await getHomeAssistantEntity(instance, requiredEntityId(instance));
    const nextState = entityStatePatch(entity);
    return JSON.stringify(state) === JSON.stringify({ ...state, ...nextState }) ? undefined : nextState;
  }

  /** Reports an entity's active state for the panel favorite indicator. */
  favoriteStateActive(instance: ResolvedPluginInstance, state: PluginState): boolean | undefined {
    if (entityDomain(instance.variables.entityId) === "cover") {
      const position = numberValue(state, "position");
      return position === undefined ? undefined : position > 0;
    }
    if (entityDomain(instance.variables.entityId) === "light") {
      const brightness = numberValue(state, "brightness");
      if (brightness !== undefined && brightness <= 0) return false;
    }
    return typeof state["isOn"] === "boolean" ? state["isOn"] : undefined;
  }

  /** Routes a favorite tap to a domain-specific action or screen. */
  async handleFavoritePress(
    instance: ResolvedPluginInstance,
    _panel: Panel,
    binding: PanelBinding,
    state: PluginState,
    _context: PluginRuntimeContext
  ): Promise<PluginFavoritePressResult> {
    const entityId = requiredEntityId(instance);
    const domain = entityDomain(entityId);
    if (domain === "cover") return this.coverControls.toggle(instance, entityId, state);
    if (domain === "vacuum") return this.vacuumControls.handleFavoritePress(instance, binding, entityId);
    if (domain === "light") return this.lightControls.toggle(instance, entityId, state);
    return this.switchControls.toggle(instance, entityId);
  }

  /** Opens the light color page or cover level page from a favorite long press. */
  handleFavoriteLongPress(
    instance: ResolvedPluginInstance,
    panel: Panel,
    binding: PanelBinding,
    _state: PluginState,
    _context: PluginRuntimeContext
  ) {
    const entityId = requiredEntityId(instance);
    const domain = entityDomain(entityId);
    if (domain === "light") return this.lightControls.openFavoritePage(panel, binding, entityId);
    if (domain === "cover") return { page: "level" as const };
    return undefined;
  }

  /** Enters and initializes a cover's firmware-native favorite level page. */
  openFavoritePanelPage(
    instance: ResolvedPluginInstance,
    panel: Panel,
    binding: PanelBinding,
    state: PluginState
  ): PluginFavoritePanelPageResult {
    return this.coverControls.openFavoritePanelPage(instance, panel, binding, state);
  }

  /** Routes native favorite level-page events to the cover controller. */
  handleFavoritePanelEvent(
    instance: ResolvedPluginInstance,
    panel: Panel,
    binding: PanelBinding,
    message: MqttMessageEnvelope,
    state: PluginState
  ): Promise<PluginFavoritePanelPageResult | undefined> {
    return this.coverControls.handleFavoritePanelEvent(instance, panel, binding, message, state);
  }

  /** Replays the selected cover's current position to its active native page. */
  renderFavoritePanelState(_instance: ResolvedPluginInstance, panel: Panel, state: PluginState) {
    return this.coverControls.renderFavoritePanelState(panel, state);
  }

  /** Renders the vacuum info page; other HA domains use their native panel page. */
  renderScreen(instance: ResolvedPluginInstance, state: PluginState, screen: string, _context: PluginRuntimeContext): PluginScreen | undefined {
    return entityDomain(instance.variables.entityId) === "vacuum"
      ? this.vacuumControls.renderScreen(instance, state, screen)
      : undefined;
  }

  /** Handles the vacuum info-page button actions. */
  handleAction(
    instance: ResolvedPluginInstance,
    state: PluginState,
    action: string,
    _context: PluginRuntimeContext
  ): Promise<PluginActionResult> {
    if (entityDomain(instance.variables.entityId) !== "vacuum") return Promise.resolve({ screen: "exit" });
    return this.vacuumControls.handleAction(instance, requiredEntityId(instance), state, action);
  }

  /** Dispatches home-tile events to the controller for the selected entity. */
  handleHomeTileEvent(
    instance: ResolvedPluginInstance,
    panel: Panel,
    index: number,
    button: Panel["settings"]["buttons"][number],
    message: MqttMessageEnvelope,
    state: PluginState,
    _context: PluginRuntimeContext
  ): Promise<PluginHomeTileResult | undefined> {
    const entityId = requiredEntityId(instance);
    const domain = entityDomain(entityId);
    const suffix = message.topic.slice(`${panel.nodeName}/event/`.length);
    if (domain === "light") {
      return this.lightControls.handleTileEvent(instance, panel, index, button, message, state, suffix, entityId);
    }
    if (domain === "cover") {
      return this.coverControls.handleTileEvent(instance, panel, index, message, state, suffix);
    }
    return Promise.resolve(undefined);
  }

  /** Renders a light or cover's current state on its home tile or detail page. */
  renderHomeTileState(
    instance: ResolvedPluginInstance,
    panel: Panel,
    index: number,
    _button: Panel["settings"]["buttons"][number],
    page: "home" | "light" | "level",
    state: PluginState
  ) {
    const domain = entityDomain(instance.variables.entityId);
    if (domain === "light") return this.lightControls.renderHomeTileState(panel, index, page, state);
    if (domain === "cover") return this.coverControls.renderHomeTileState(panel, index, page, state);
    return [];
  }
}
