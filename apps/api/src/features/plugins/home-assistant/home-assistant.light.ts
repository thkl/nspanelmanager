import type { Panel, PanelBinding, ResolvedPluginInstance } from "../../../types.js";
import type {
  MqttMessageEnvelope,
  PluginFavoriteLongPressResult,
  PluginHomeTileResult,
  PluginState
} from "../plugin-contract.js";
import { configNumber, configString } from "../plugin-contract.js";
import {
  callHomeAssistantService,
  clampPercent,
  getHomeAssistantEntity,
  entityStatePatch,
  numberValue,
  parseHexRgb,
  parseNextionWheelColor,
  recordFromJson,
  scalarNumber
} from "./home-assistant.api.js";

/**
 * Translates panel light-tile and color-page events into Home Assistant light
 * services. It also formats the color page's two configurable presets.
 */
export class HomeAssistantLightControls {
  private readonly levelPresets = [
    { label: "Off", value: 0 },
    { label: "25%", value: 25 },
    { label: "50%", value: 50 },
    { label: "75%", value: 75 },
    { label: "On", value: 100 }
  ];

  /** Toggles a light and applies the configured brightness when turning it on. */
  async toggle(instance: ResolvedPluginInstance, entityId: string, state: PluginState): Promise<PluginHomeTileResult> {
    const brightness = numberValue(state, "brightness");
    const isOn = state["isOn"] === true && (brightness === undefined || brightness > 0);
    if (isOn) {
      await callHomeAssistantService(instance, "light", "turn_off", entityId);
    } else {
      await callHomeAssistantService(instance, "light", "turn_on", entityId, {
        brightness_pct: clampPercent(configNumber(instance, "lightOnBrightness", 50))
      });
    }
    return this.refreshState(instance, entityId);
  }

  /** Opens the panel color page when the user holds a light favorite. */
  openFavoritePage(panel: Panel, binding: PanelBinding, entityId: string): PluginFavoriteLongPressResult {
    return {
      page: "light",
      commands: [{
        topic: `${panel.nodeName}/cmnd/colorLamp`,
        payload: JSON.stringify({ label: binding.name, id: entityId })
      }]
    };
  }

  /** Handles one light tile action or an event from its color page. */
  async handleTileEvent(
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
      return this.toggle(instance, entityId, state);
    }
    if (itemEvent && (message.payload === "up" || message.payload === "dn")) {
      const current = numberValue(state, "brightness") ?? 0;
      const step = configNumber(instance, "lightBrightnessStep", 10);
      const delta = message.payload === "up" ? step : -step;
      return this.setBrightness(instance, entityId, current + delta);
    }
    if (new RegExp(`^level/${index}$`).test(suffix) && message.payload.trim().toLowerCase() === "query") {
      return {
        page: "level",
        commands: [
          this.levelConfiguration(panel, button.label),
          ...this.renderHomeTileState(panel, index, "level", state)
        ]
      };
    }
    if (new RegExp(`^level/set/${index}$`).test(suffix)) {
      const requested = requestedBrightness(message.payload);
      return requested === undefined ? undefined : this.setBrightness(instance, entityId, requested);
    }
    if (suffix === "colorLamp" || suffix === "colorLamp/set") {
      return this.handleColorPageEvent(instance, message.payload, state, entityId);
    }
    if (suffix === "colorscene") {
      const event = recordFromJson(message.payload);
      const preset = event && scalarNumber(event["button"]);
      if (preset === 1 || preset === 2) return this.setPreset(instance, entityId, preset);
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

  /** Renders the selected light's active state or brightness on its home tile. */
  renderHomeTileState(
    panel: Panel,
    index: number,
    page: "home" | "light" | "level",
    state: PluginState
  ) {
    const brightness = numberValue(state, "brightness");
    if (page === "level") {
      return brightness === undefined
        ? []
        : [{ topic: `${panel.nodeName}/cmnd/level/status`, payload: String(Math.round(brightness)) }];
    }
    if (page !== "home") return [];
    const isOn = state["isOn"] === true && (brightness === undefined || brightness > 0);
    const label = !isOn
      ? "Off"
      : brightness !== undefined && brightness < 100
        ? `${Math.round(brightness)} %`
        : "On";
    return [{ topic: `${panel.nodeName}/cmnd/status`, payload: JSON.stringify({ [index]: { label } }) }];
  }

  /** Handles brightness and color values sent by the panel's color page. */
  private async handleColorPageEvent(
    instance: ResolvedPluginInstance,
    payload: string,
    state: PluginState,
    entityId: string
  ): Promise<PluginHomeTileResult | undefined> {
    const event = recordFromJson(payload);
    if (!event) {
      const brightness = scalarNumber(payload);
      return brightness === undefined ? undefined : this.setBrightness(instance, entityId, brightness);
    }
    const requestedEntityId = typeof event["topic"] === "string" ? event["topic"].trim() : "";
    if (requestedEntityId && requestedEntityId !== entityId) return undefined;

    if (Object.hasOwn(event, "brightness") || Object.hasOwn(event, "level")) {
      const requested = Object.hasOwn(event, "brightness") ? event["brightness"] : event["level"];
      return this.handleBrightnessChange(instance, requested, state, entityId);
    }
    if (typeof event["color"] === "string") {
      const rgbColor = parseNextionWheelColor(event["color"]);
      if (!rgbColor) return undefined;
      const brightness = numberValue(state, "brightness");
      const data: Record<string, unknown> = {
        rgb_color: rgbColor,
        brightness_pct: clampPercent(
          brightness !== undefined && brightness > 0
            ? brightness
            : configNumber(instance, "lightOnBrightness", 50)
        )
      };
      await callHomeAssistantService(instance, "light", "turn_on", entityId, data);
      return this.refreshState(instance, entityId);
    }
    return undefined;
  }

  /** Converts the panel's preset, step, or numeric brightness event into a service call. */
  private async handleBrightnessChange(
    instance: ResolvedPluginInstance,
    requestedBrightness: unknown,
    state: PluginState,
    entityId: string
  ): Promise<PluginHomeTileResult | undefined> {
    const value = String(requestedBrightness ?? "").trim();
    if (value === "PSET1") return this.setPreset(instance, entityId, 1);
    if (value === "PSET2") return this.setPreset(instance, entityId, 2);
    if (value === "+10" || value === "-10") {
      const current = numberValue(state, "brightness") ?? 0;
      return this.setBrightness(instance, entityId, current + (value === "+10" ? 10 : -10));
    }
    const brightness = scalarNumber(requestedBrightness);
    return brightness === undefined ? undefined : this.setBrightness(instance, entityId, brightness);
  }

  /** Sets brightness or switches the light off at zero percent. */
  private async setBrightness(instance: ResolvedPluginInstance, entityId: string, requested: number): Promise<PluginHomeTileResult> {
    const brightness = clampPercent(requested);
    const service = brightness === 0 ? "turn_off" : "turn_on";
    const data = brightness === 0 ? {} : { brightness_pct: brightness };
    await callHomeAssistantService(instance, "light", service, entityId, data);
    return this.refreshState(instance, entityId);
  }

  /** Applies the selected configurable RGB preset and brightness. */
  private async setPreset(
    instance: ResolvedPluginInstance,
    entityId: string,
    preset: 1 | 2
  ): Promise<PluginHomeTileResult | undefined> {
    const key = preset === 1 ? "lightPreset1Rgb" : "lightPreset2Rgb";
    const fallback = preset === 1 ? "#ffffff" : "#ffb35c";
    const rgbColor = parseHexRgb(configString(instance, key, fallback));
    if (!rgbColor) return undefined;

    await callHomeAssistantService(instance, "light", "turn_on", entityId, {
      rgb_color: rgbColor,
      brightness_pct: clampPercent(configNumber(instance, "lightPresetBrightness", 100))
    });
    return this.refreshState(instance, entityId);
  }

  /** Reads the entity after a service call so tile state reflects Home Assistant. */
  private async refreshState(instance: ResolvedPluginInstance, entityId: string): Promise<PluginHomeTileResult> {
    const entity = await getHomeAssistantEntity(instance, entityId);
    return { statePatch: entityStatePatch(entity) };
  }

  /** Configures the firmware's native brightness level page. */
  private levelConfiguration(panel: Panel, title: string) {
    return {
      topic: `${panel.nodeName}/cmnd/level/config`,
      payload: JSON.stringify({
        name: title,
        settings: this.levelPresets,
        levelTopic: "",
        topic: "",
        version: "2"
      })
    };
  }
}

/** Reads level values from the panel's JSON envelope or a plain numeric payload. */
function requestedBrightness(payload: string): number | undefined {
  const numericPayload = scalarNumber(payload);
  if (numericPayload !== undefined) return numericPayload;
  const event = recordFromJson(payload);
  return event ? scalarNumber(event["level"] ?? event["brightness"] ?? event["value"]) : undefined;
}
