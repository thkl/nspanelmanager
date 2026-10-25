import type { Panel, PanelBinding, PluginConfigValue, ResolvedPluginInstance } from "../../types.js";
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
import { configNumber, configString } from "./plugin-contract.js";
import { XYToRGB } from "./nextion-color-wheel.js";

const TOGGLEABLE_DOMAINS = new Set(["fan", "input_boolean", "light", "media_player", "switch"]);
const SUPPORTED_DOMAINS = new Set([...TOGGLEABLE_DOMAINS, "cover", "vacuum"]);
const COVER_PRESETS = [
  { label: "Closed", value: 0 },
  { label: "25%", value: 25 },
  { label: "50%", value: 50 },
  { label: "75%", value: 75 },
  { label: "Open", value: 100 }
];

interface HomeAssistantEntity {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
}

export interface HomeAssistantEntityOption {
  entityId: string;
  name: string;
  state: string;
  domain: string;
}

/** Controls selected Home Assistant entities through REST calls and panel-native pages. */
export class HomeAssistantPlugin implements PluginDefinition {
  readonly id = "home-assistant";
  readonly name = "Home Assistant";
  readonly version = 2;
  readonly description = "Select Home Assistant devices for toggle, color-light, cover-level, or vacuum controls.";
  readonly capabilities = ["home-assistant", "favorite-toggle", "favorite-page", "home-tile"];
  readonly favoriteFlow = true;
  readonly homeTileTypeByEntityDomain = { light: "light", cover: "cover" } as const;
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

  /** Checks the Home Assistant URL, token, refresh interval, and panel adjustment steps. */
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
      if (step === undefined || step <= 0 || step > 100) {
        return "Light and cover steps must be greater than 0 and no more than 100 percent.";
      }
    }
    for (const key of ["lightPreset1Rgb", "lightPreset2Rgb"]) {
      if (!/^#?[0-9a-f]{6}$/i.test(stringValue(config, key) || (key === "lightPreset1Rgb" ? "#ffffff" : "#ffb35c"))) {
        return "Light color presets must be six-digit hexadecimal RGB colors.";
      }
    }
    const presetBrightness = numberValue(config, "lightPresetBrightness") ?? 100;
    if (presetBrightness < 1 || presetBrightness > 100) {
      return "Preset brightness must be between 1 and 100 percent.";
    }
    return undefined;
  }

  /** Requires an entity supported by the profile's Home Assistant connection. */
  validateInstance(instance: ResolvedPluginInstance): string | undefined {
    if (!isSupportedEntityId(instance.variables.entityId)) {
      return "Choose a supported Home Assistant light, cover, vacuum, switch, fan, or media player.";
    }
    return undefined;
  }

  /** Resolves panel home-tile behavior from the selected entity domain. */
  homeTileTypeForInstance(instance: ResolvedPluginInstance): "light" | "cover" | undefined {
    const domain = entityDomain(instance.variables.entityId);
    return domain ? this.homeTileTypeByEntityDomain[domain as "light" | "cover"] : undefined;
  }

  /** Uses the built-in level page for cover favorite long-presses. */
  favoritePanelPageForInstance(instance: ResolvedPluginInstance): "level" | undefined {
    return entityDomain(instance.variables.entityId) === "cover" ? "level" : undefined;
  }

  /** This integration receives its state through HTTP polling, not MQTT. */
  subscriptions(_instance: ResolvedPluginInstance): readonly string[] {
    return [];
  }

  /** Does not decode MQTT state. */
  decodeMessage(_instance: ResolvedPluginInstance, _message: MqttMessageEnvelope): PluginState | undefined {
    return undefined;
  }

  /** Polls the selected entity at the configured interval. */
  pollIntervalMs(instance: ResolvedPluginInstance): number {
    return configNumber(instance, "pollSeconds", 60) * 1000;
  }

  /** Reads the current entity state and caches changes for the panel and info page. */
  async poll(instance: ResolvedPluginInstance, state: PluginState): Promise<PluginState | undefined> {
    const entity = await getHomeAssistantEntity(instance, requiredEntityId(instance));
    const nextState = entityStatePatch(entity);
    return JSON.stringify(state) === JSON.stringify({ ...state, ...nextState }) ? undefined : nextState;
  }

  /** Shows whether the device is active, a cover is open, or a vacuum is cleaning. */
  favoriteStateActive(instance: ResolvedPluginInstance, state: PluginState): boolean | undefined {
    const domain = entityDomain(instance.variables.entityId);
    if (domain === "cover") {
      const position = numberValue(state, "position");
      return position === undefined ? undefined : position > 0;
    }
    return typeof state["isOn"] === "boolean" ? state["isOn"] : undefined;
  }

  /** Toggles an entity, or opens the vacuum's information page from a favorite. */
  async handleFavoritePress(
    instance: ResolvedPluginInstance,
    _panel: Panel,
    binding: PanelBinding,
    state: PluginState,
    _context: PluginRuntimeContext
  ): Promise<PluginFavoritePressResult> {
    const entityId = requiredEntityId(instance);
    const domain = entityDomain(entityId);
    if (domain === "vacuum" && !binding.id.startsWith("hardware-button:")) {
      return { screen: "overview" };
    }
    if (domain === "cover") {
      return this.toggleCover(instance, entityId, state);
    }
    if (domain === "vacuum") {
      return this.runVacuumAction(instance, entityId, "start_pause");
    }
    await callHomeAssistantService(instance, "homeassistant", "toggle", entityId);
    const entity = await getHomeAssistantEntity(instance, entityId);
    return { statePatch: entityStatePatch(entity) };
  }

  /** Opens the light color page or the cover level page when a favorite is held. */
  handleFavoriteLongPress(
    instance: ResolvedPluginInstance,
    panel: Panel,
    binding: PanelBinding,
    _state: PluginState,
    _context: PluginRuntimeContext
  ) {
    const entityId = requiredEntityId(instance);
    const domain = entityDomain(entityId);
    if (domain === "light") {
      return {
        page: "light" as const,
        commands: [{
          topic: `${panel.nodeName}/cmnd/colorLamp`,
          payload: JSON.stringify({ label: binding.name, id: entityId })
        }]
      };
    }
    if (domain === "cover") {
      return { page: "level" as const };
    }
    return undefined;
  }

  /** Opens and initializes the native cover level page from a favorite flow. */
  openFavoritePanelPage(
    instance: ResolvedPluginInstance,
    panel: Panel,
    binding: PanelBinding,
    state: PluginState
  ): PluginFavoritePanelPageResult {
    const entityId = requiredEntityId(instance);
    const commands = [
      { topic: `${panel.nodeName}/cmnd/goto`, payload: JSON.stringify({ page: "pageLevel" }) },
      this.coverLevelConfiguration(panel, binding.name || instance.name, entityId),
      ...this.renderFavoritePanelState(instance, panel, state)
    ];
    return { commands };
  }

  /** Refreshes cover page presets and sends slider changes to Home Assistant. */
  async handleFavoritePanelEvent(
    instance: ResolvedPluginInstance,
    panel: Panel,
    binding: PanelBinding,
    message: MqttMessageEnvelope,
    state: PluginState
  ): Promise<PluginFavoritePanelPageResult | undefined> {
    const entityId = requiredEntityId(instance);
    const suffix = message.topic.slice(`${panel.nodeName}/event/`.length);
    if (/^level\/\d{1,2}$/.test(suffix) && message.payload.trim().toLowerCase() === "query") {
      return {
        commands: [
          this.coverLevelConfiguration(panel, binding.name || instance.name, entityId),
          ...this.renderFavoritePanelState(instance, panel, state)
        ]
      };
    }
    if (!/^level\/set\/\d{1,2}$/.test(suffix)) return undefined;
    const position = scalarNumber(message.payload);
    if (position === undefined) return undefined;
    return this.setCoverPosition(instance, entityId, position);
  }

  /** Replays the selected cover's normalized position to its active level page. */
  renderFavoritePanelState(_instance: ResolvedPluginInstance, panel: Panel, state: PluginState) {
    const position = numberValue(state, "position");
    if (position === undefined) return [];
    return [{ topic: `${panel.nodeName}/cmnd/level/status`, payload: String(Math.round(position)) }];
  }

  /** Renders vacuum telemetry as a simple plugin info page with useful actions. */
  renderScreen(instance: ResolvedPluginInstance, state: PluginState, screen: string, _context: PluginRuntimeContext): PluginScreen | undefined {
    if (entityDomain(instance.variables.entityId) !== "vacuum" || screen !== "overview") return undefined;
    const details = [`Status: ${displayValue(state["entityState"], "Unknown")}`];
    const batteryLevel = numberValue(state, "batteryLevel");
    const fanSpeed = displayValue(state["fanSpeed"], "");
    const vacuumError = displayValue(state["vacuumError"], "");
    if (batteryLevel !== undefined) details.push(`Battery: ${Math.round(batteryLevel)}%`);
    if (fanSpeed) details.push(`Fan speed: ${fanSpeed}`);
    if (vacuumError) details.push(`Issue: ${vacuumError}`);
    return {
      title: displayValue(state["entityName"], instance.name),
      message: details.join("\n"),
      buttons: [
        { label: "Start / Pause", action: "vacuum:start_pause" },
        { label: "Return to dock", action: "vacuum:return_to_base" },
        { label: "Locate", action: "vacuum:locate" }
      ]
    };
  }

  /** Runs supported vacuum actions from the plugin info screen and refreshes state. */
  async handleAction(
    instance: ResolvedPluginInstance,
    _state: PluginState,
    action: string,
    _context: PluginRuntimeContext
  ): Promise<PluginActionResult> {
    const match = /^vacuum:(start_pause|return_to_base|locate)$/.exec(action);
    if (entityDomain(instance.variables.entityId) !== "vacuum" || !match) return { screen: "exit" };
    const result = await this.runVacuumAction(instance, requiredEntityId(instance), match[1]);
    return { screen: "overview", statePatch: result.statePatch };
  }

  /** Routes bound light and cover home-tile events to Home Assistant actions. */
  async handleHomeTileEvent(
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
      return this.handleLightTileEvent(instance, panel, index, button, message, state, suffix, entityId);
    }
    if (domain === "cover") {
      return this.handleCoverTileEvent(instance, panel, index, button, message, state, suffix, entityId);
    }
    return undefined;
  }

  /** Maps Home Assistant state to the configured tile label or active level slider. */
  renderHomeTileState(
    instance: ResolvedPluginInstance,
    panel: Panel,
    index: number,
    _button: Panel["settings"]["buttons"][number],
    page: "home" | "light" | "level",
    state: PluginState
  ) {
    const domain = entityDomain(instance.variables.entityId);
    if (page === "level" && domain === "cover") {
      const position = numberValue(state, "position");
      return position === undefined
        ? []
        : [{ topic: `${panel.nodeName}/cmnd/level/status`, payload: String(Math.round(position)) }];
    }
    if (page !== "home") return [];
    if (domain === "light") {
      const isOn = state["isOn"] === true;
      const brightness = numberValue(state, "brightness");
      const label = !isOn
        ? "Off"
        : brightness !== undefined && brightness < 100
          ? `${Math.round(brightness)} %`
          : "On";
      return [{ topic: `${panel.nodeName}/cmnd/status`, payload: JSON.stringify({ [index]: { label } }) }];
    }
    if (domain === "cover") {
      const position = numberValue(state, "position");
      if (position === undefined) return [];
      const label = position === 0 ? "Closed" : position === 100 ? "Open" : `${Math.round(position)} %`;
      return [{ topic: `${panel.nodeName}/cmnd/status`, payload: JSON.stringify({ [index]: { label } }) }];
    }
    return [];
  }

  private async handleLightTileEvent(
    instance: ResolvedPluginInstance,
    panel: Panel,
    index: number,
    button: Panel["settings"]["buttons"][number],
    message: MqttMessageEnvelope,
    state: PluginState,
    suffix: string,
    entityId: string
  ): Promise<PluginHomeTileResult | undefined> {
    const itemEvent = new RegExp(`^item/${index}$`).test(suffix);
    if (itemEvent && message.payload === "longpress") {
      return {
        page: "light",
        commands: [{
          topic: `${panel.nodeName}/cmnd/colorLamp`,
          payload: JSON.stringify({ label: button.label, id: entityId })
        }]
      };
    }
    if (itemEvent && message.payload === "toggle") {
      await callHomeAssistantService(instance, "light", "toggle", entityId);
      return this.refreshedState(instance, entityId);
    }
    if (itemEvent && (message.payload === "up" || message.payload === "dn")) {
      const current = numberValue(state, "brightness") ?? 0;
      const step = configNumber(instance, "lightBrightnessStep", 10);
      return this.setLightBrightness(instance, entityId, current + (message.payload === "up" ? step : -step));
    }
    if (suffix === "colorLamp" || suffix === "colorLamp/set") {
      return this.handleColorLampEvent(instance, panel, message.payload, state, entityId);
    }
    if (suffix === "colorscene") {
      const event = recordFromJson(message.payload);
      const preset = event && scalarNumber(event["button"]);
      if (preset === 1 || preset === 2) {
        return this.setLightPreset(instance, entityId, preset);
      }
    }
    if (suffix === "page/colorlamp") {
      const event = recordFromJson(message.payload);
      if (event?.["page"] === "0") {
        return {
          page: "home",
          commands: [{ topic: `${panel.nodeName}/cmnd/nextion`, payload: "page page0" }]
        };
      }
    }
    return undefined;
  }

  private async handleColorLampEvent(
    instance: ResolvedPluginInstance,
    panel: Panel,
    payload: string,
    state: PluginState,
    entityId: string
  ): Promise<PluginHomeTileResult | undefined> {
    const event = recordFromJson(payload);
    if (!event) return undefined;
    const requestedEntityId = typeof event["topic"] === "string" ? event["topic"].trim() : "";
    if (requestedEntityId && requestedEntityId !== entityId) return undefined;
    if (Object.hasOwn(event, "brightness")) {
      const rawBrightness = String(event["brightness"] ?? "").trim();
      if (rawBrightness === "PSET1") return this.setLightPreset(instance, entityId, 1);
      if (rawBrightness === "PSET2") return this.setLightPreset(instance, entityId, 2);
      if (rawBrightness === "+10" || rawBrightness === "-10") {
        const current = numberValue(state, "brightness") ?? 0;
        const delta = rawBrightness === "+10" ? 10 : -10;
        return this.setLightBrightness(instance, entityId, current + delta);
      }
      const brightness = scalarNumber(event["brightness"]);
      return brightness === undefined ? undefined : this.setLightBrightness(instance, entityId, brightness);
    }
    if (typeof event["color"] === "string") {
      const color = parseNextionWheelColor(event["color"]);
      if (!color) return undefined;
      const brightness = numberValue(state, "brightness");
      const data: Record<string, unknown> = { rgb_color: color };
      if (brightness !== undefined && brightness > 0) data["brightness_pct"] = Math.round(brightness);
      await callHomeAssistantService(instance, "light", "turn_on", entityId, data);
      return this.refreshedState(instance, entityId);
    }
    return undefined;
  }

  private async handleCoverTileEvent(
    instance: ResolvedPluginInstance,
    panel: Panel,
    index: number,
    _button: Panel["settings"]["buttons"][number],
    message: MqttMessageEnvelope,
    state: PluginState,
    suffix: string,
    entityId: string
  ): Promise<PluginHomeTileResult | undefined> {
    if (new RegExp(`^level/${index}$`).test(suffix) && message.payload.trim().toLowerCase() === "query") {
      return {
        page: "level",
        commands: [
          this.coverLevelConfiguration(panel, instance.name, entityId),
          ...this.renderFavoritePanelState(instance, panel, state)
        ]
      };
    }
    if (new RegExp(`^level/set/${index}$`).test(suffix)) {
      const position = scalarNumber(message.payload);
      if (position === undefined) return undefined;
      return this.setCoverPosition(instance, entityId, position);
    }
    if (!new RegExp(`^item/${index}$`).test(suffix)) return undefined;
    if (message.payload === "toggle") {
      return this.toggleCover(instance, entityId, state);
    }
    if (message.payload === "up" || message.payload === "dn") {
      const current = numberValue(state, "position") ?? (message.payload === "up" ? 0 : 100);
      const step = configNumber(instance, "coverPositionStep", 10);
      const delta = message.payload === "up" ? step : -step;
      return this.setCoverPosition(instance, entityId, current + delta);
    }
    if (message.payload === "stop") {
      await callHomeAssistantService(instance, "cover", "stop_cover", entityId);
      return this.refreshedState(instance, entityId);
    }
    return undefined;
  }

  private async setLightBrightness(instance: ResolvedPluginInstance, entityId: string, requested: number): Promise<PluginHomeTileResult> {
    const brightness = clampPercent(requested);
    const service = brightness === 0 ? "turn_off" : "turn_on";
    const data = brightness === 0 ? {} : { brightness_pct: brightness };
    await callHomeAssistantService(instance, "light", service, entityId, data);
    return this.refreshedState(instance, entityId);
  }

  private async setLightPreset(instance: ResolvedPluginInstance, entityId: string, preset: 1 | 2): Promise<PluginHomeTileResult | undefined> {
    const key = preset === 1 ? "lightPreset1Rgb" : "lightPreset2Rgb";
    const rgbColor = parseHexRgb(configString(instance, key, preset === 1 ? "#ffffff" : "#ffb35c"));
    if (!rgbColor) return undefined;
    await callHomeAssistantService(instance, "light", "turn_on", entityId, {
      rgb_color: rgbColor,
      brightness_pct: clampPercent(configNumber(instance, "lightPresetBrightness", 100))
    });
    return this.refreshedState(instance, entityId);
  }

  private async setCoverPosition(instance: ResolvedPluginInstance, entityId: string, requested: number): Promise<PluginHomeTileResult> {
    const position = clampPercent(requested);
    await callHomeAssistantService(instance, "cover", "set_cover_position", entityId, { position });
    return this.refreshedState(instance, entityId);
  }

  private async toggleCover(instance: ResolvedPluginInstance, entityId: string, state: PluginState): Promise<PluginHomeTileResult> {
    const position = numberValue(state, "position");
    const isOpen = position === undefined
      ? String(state["entityState"] ?? "").toLowerCase() === "open"
      : position > 0;
    await callHomeAssistantService(instance, "cover", isOpen ? "close_cover" : "open_cover", entityId);
    return this.refreshedState(instance, entityId);
  }

  private async runVacuumAction(instance: ResolvedPluginInstance, entityId: string, action: string): Promise<PluginFavoritePressResult> {
    await callHomeAssistantService(instance, "vacuum", action, entityId);
    const entity = await getHomeAssistantEntity(instance, entityId);
    return { statePatch: entityStatePatch(entity) };
  }

  private async refreshedState(instance: ResolvedPluginInstance, entityId: string): Promise<PluginHomeTileResult> {
    const entity = await getHomeAssistantEntity(instance, entityId);
    return { statePatch: entityStatePatch(entity) };
  }

  private coverLevelConfiguration(panel: Panel, title: string, entityId: string) {
    return {
      topic: `${panel.nodeName}/cmnd/level/config`,
      payload: JSON.stringify({
        name: title,
        settings: COVER_PRESETS,
        levelTopic: entityId,
        topic: "",
        version: "2"
      })
    };
  }
}

/** Lists all supported entity types that can be selected for a Home Assistant instance. */
export async function fetchHomeAssistantEntityOptions(baseUrl: string, accessToken: string): Promise<HomeAssistantEntityOption[]> {
  const response = await homeAssistantFetch(baseUrl, accessToken, "/api/states");
  if (!Array.isArray(response)) throw new Error("Home Assistant returned an invalid entity list.");
  return response
    .filter((entity): entity is HomeAssistantEntity => isRecord(entity) && isSupportedEntityId(entity["entity_id"]))
    .map((entity) => {
      const entityId = entity.entity_id;
      const domain = entityDomain(entityId) ?? "";
      const friendlyName = entity.attributes?.["friendly_name"];
      return {
        entityId,
        name: typeof friendlyName === "string" && friendlyName.trim() ? friendlyName.trim() : entityId,
        state: typeof entity.state === "string" ? entity.state : "unknown",
        domain
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}

function requiredEntityId(instance: ResolvedPluginInstance): string {
  const entityId = instance.variables.entityId?.trim() ?? "";
  if (!isSupportedEntityId(entityId)) throw new Error("Choose a supported Home Assistant entity for this instance.");
  return entityId;
}

async function getHomeAssistantEntity(instance: ResolvedPluginInstance, entityId: string): Promise<HomeAssistantEntity> {
  const encodedEntityId = entityId.split(".").map(encodeURIComponent).join(".");
  const value = await homeAssistantFetch(
    configString(instance, "baseUrl"),
    configString(instance, "accessToken"),
    `/api/states/${encodedEntityId}`
  );
  if (!isRecord(value) || typeof value["entity_id"] !== "string" || typeof value["state"] !== "string") {
    throw new Error(`Home Assistant returned invalid state for ${entityId}.`);
  }
  return value as unknown as HomeAssistantEntity;
}

async function callHomeAssistantService(
  instance: ResolvedPluginInstance,
  domain: string,
  service: string,
  entityId: string,
  data: Record<string, unknown> = {}
): Promise<void> {
  await homeAssistantFetch(
    configString(instance, "baseUrl"),
    configString(instance, "accessToken"),
    `/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`,
    {
      method: "POST",
      body: JSON.stringify({ entity_id: entityId, ...data })
    }
  );
}

function entityStatePatch(entity: HomeAssistantEntity): PluginState {
  const domain = entityDomain(entity.entity_id);
  const attributes = entity.attributes ?? {};
  const state = entity.state.trim().toLowerCase();
  const patch: PluginState = {
    entityId: entity.entity_id,
    entityDomain: domain,
    entityState: entity.state,
    entityName: displayValue(attributes["friendly_name"], entity.entity_id),
    available: state !== "unavailable" && state !== "unknown",
    isOn: ["on", "playing", "buffering", "cleaning", "returning", "paused"].includes(state)
  };

  if (domain === "light") {
    const brightness = numberValue(attributes, "brightness");
    if (brightness !== undefined) {
      patch["brightness"] = Math.round(brightness / 255 * 100);
      patch["lastBrightness"] = patch["brightness"];
    }
    const rgbColor = attributes["rgb_color"];
    if (isRgbColor(rgbColor)) patch["rgbColor"] = rgbColor;
  }
  if (domain === "cover") {
    const position = numberValue(attributes, "current_position");
    if (position !== undefined) patch["position"] = clampPercent(position);
  }
  if (domain === "vacuum") {
    const batteryLevel = numberValue(attributes, "battery_level");
    if (batteryLevel !== undefined) patch["batteryLevel"] = batteryLevel;
    if (typeof attributes["fan_speed"] === "string") patch["fanSpeed"] = attributes["fan_speed"];
    if (typeof attributes["error"] === "string") patch["vacuumError"] = attributes["error"];
    if (typeof attributes["status"] === "string") patch["vacuumStatus"] = attributes["status"];
  }
  return patch;
}

async function homeAssistantFetch(baseUrl: string, accessToken: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const normalizedBaseUrl = normalizeHomeAssistantBaseUrl(baseUrl);
  if (!accessToken.trim()) throw new Error("Set the Home Assistant access token in the plugin profile.");
  const response = await fetch(`${normalizedBaseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...init.headers
    },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    throw new Error(response.status === 401 || response.status === 403
      ? "Home Assistant rejected the access token. Check the saved token and permissions."
      : `Home Assistant returned HTTP ${response.status}.`);
  }
  if (response.status === 204) return undefined;
  return response.json();
}

function validHomeAssistantBaseUrl(value: string): boolean {
  try {
    normalizeHomeAssistantBaseUrl(value);
    return true;
  } catch {
    return false;
  }
}

function normalizeHomeAssistantBaseUrl(value: string): string {
  const url = new URL(value.trim());
  if (!(url.protocol === "http:" || url.protocol === "https:") || url.username || url.password || url.search || url.hash) {
    throw new Error("Home Assistant URL must use HTTP or HTTPS and must not include credentials, query parameters, or a fragment.");
  }
  return url.toString().replace(/\/+$/, "");
}

function stringValue(config: Record<string, PluginConfigValue>, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value : "";
}

function numberValue(value: Record<string, unknown>, key: string): number | undefined {
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function scalarNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function entityDomain(entityId: string | undefined): string | undefined {
  return entityId?.split(".")[0]?.toLowerCase();
}

function isSupportedEntityId(value: unknown): value is string {
  if (typeof value !== "string" || !/^[a-z_][a-z0-9_]*\.[a-z0-9_]+$/i.test(value)) return false;
  const domain = entityDomain(value);
  return Boolean(domain && SUPPORTED_DOMAINS.has(domain));
}

function isRgbColor(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every((channel) =>
    typeof channel === "number" && Number.isFinite(channel) && channel >= 0 && channel <= 255
  );
}

function parseNextionWheelColor(value: string): [number, number, number] | undefined {
  const channels = value.trim().split("|");
  if (channels.length !== 2 || channels.some((channel) => !/^\d+$/.test(channel))) return undefined;
  const [x, y] = channels.map(Number);
  if (x < 0 || x > 200 || y < 0 || y > 200) return undefined;
  const color = XYToRGB(value);
  return [color.r, color.g, color.b];
}

function parseHexRgb(value: string): [number, number, number] | undefined {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value.trim());
  if (!match) return undefined;
  return [Number.parseInt(match[1], 16), Number.parseInt(match[2], 16), Number.parseInt(match[3], 16)];
}

function recordFromJson(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function displayValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
