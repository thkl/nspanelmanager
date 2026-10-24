import type { Panel, PanelBinding, PluginConfigValue, ResolvedPluginInstance } from "../../types.js";
import type { MqttMessageEnvelope, PluginActionResult, PluginCommand, PluginConfigField, PluginDefinition, PluginFavoritePressResult, PluginHomeTileResult, PluginRuntimeContext, PluginScreen, PluginState } from "./plugin-contract.js";
import { isTopicTemplateValid, readPayloadValue, scalarNumber, tileCommand, tileConfigNumber, tileConfigString } from "./home-tile-utils.js";
import { interpolatePluginTemplate } from "./plugin-variables.js";

/** Controls an MQTT dimmable light using only level and power commands. */
export class MqttDimmableLightPlugin implements PluginDefinition {
  readonly id = "mqtt-dimmable-light";
  readonly name = "MQTT dimmable light";
  readonly version = 1;
  readonly description = "Control an MQTT light's power and dimming level without color controls.";
  readonly capabilities = ["mqtt", "light", "dimmable", "home-tile", "favorite-toggle"];
  readonly favoriteFlow = true;
  readonly homeTileType = "light" as const;
  readonly configSchema: readonly PluginConfigField[] = [
    { key: "stateTopicFilter", label: "State topic filter", type: "text", required: true, defaultValue: "zigbee2mqtt/{{device}}", help: "MQTT topic that reports the light level. Use {{device}} or other instance variables when needed." },
    { key: "stateValuePath", label: "State level path", type: "text", defaultValue: "level", help: "Dot path to the numeric level in a JSON payload. Leave blank when the payload itself is the number." },
    { key: "zeroLevel", label: "Zero / OFF level", type: "number", required: true, defaultValue: 0, help: "Device level value that represents off." },
    { key: "onLevel", label: "ON / full level", type: "number", required: true, defaultValue: 254, help: "Device level value used when turning the light on and as the top of the dimming range." },
    { key: "commandTopic", label: "Command topic", type: "text", required: true, defaultValue: "zigbee2mqtt/{{device}}/set", help: "MQTT topic used by level, on, and off commands." },
    { key: "levelPayloadTemplate", label: "Set level payload template", type: "textarea", defaultValue: "{\"level\":{{value}},\"transition\":{{rampTime}}}", help: "Used while dimming. {{value}} is the device level; {{levelPercent}} is 0–100; {{rampTime}} is the configured ramp time. Add device-specific fields here." },
    { key: "onPayloadTemplate", label: "ON payload template", type: "textarea", defaultValue: "{\"level\":{{value}},\"transition\":{{rampTime}}}", help: "Used when toggling on. {{value}} is the configured ON level; {{levelPercent}} is 100; {{rampTime}} is the configured ramp time." },
    { key: "offPayloadTemplate", label: "OFF payload template", type: "textarea", defaultValue: "{\"level\":{{value}},\"transition\":{{rampTime}}}", help: "Used when toggling off. {{value}} is the configured zero level; {{levelPercent}} is 0; {{rampTime}} is the configured ramp time." },
    { key: "rampTime", label: "Ramp time", type: "number", defaultValue: 0.5, help: "Value supplied to {{rampTime}} in the payload templates, in the units expected by your device." },
    { key: "brightnessStep", label: "Tile dimming step (%)", type: "number", defaultValue: 10, help: "Level change for the home tile's Up and Down controls." }
  ];

  /** Validates topics, level bounds, dimming step, and command templates. */
  validateConfig(config: Record<string, PluginConfigValue>): string | undefined {
    if (!isTopicTemplateValid(stringValue(config, "stateTopicFilter"), true)) return "Enter a valid MQTT light state topic filter.";
    if (!isTopicTemplateValid(stringValue(config, "commandTopic"))) return "Enter a valid MQTT light command topic.";
    const zeroLevel = numberValue(config, "zeroLevel");
    const onLevel = numberValue(config, "onLevel");
    if (zeroLevel === undefined || onLevel === undefined || onLevel <= zeroLevel) return "The ON level must be greater than the zero level.";
    const rampTime = numberValue(config, "rampTime");
    if (rampTime === undefined || rampTime < 0 || rampTime > 3600) return "Ramp time must be a number between 0 and 3600.";
    const step = numberValue(config, "brightnessStep");
    if (step === undefined || step <= 0 || step > 100) return "Tile dimming step must be greater than 0 and no more than 100 percent.";
    if (!["levelPayloadTemplate", "onPayloadTemplate", "offPayloadTemplate"].every((key) => stringValue(config, key).trim())) {
      return "Configure level, ON, and OFF payload templates.";
    }
    return undefined;
  }

  /** Checks required instance variables and validates resolved MQTT topics. */
  validateInstance(instance: ResolvedPluginInstance): string | undefined {
    for (const key of ["stateTopicFilter", "commandTopic"]) {
      for (const [, name] of stringValue(instance.config, key).matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) {
        if (!instance.variables[name]?.trim()) return `Set the '${name}' variable on this dimmable light instance.`;
      }
    }
    const filter = interpolatePluginTemplate(stringValue(instance.config, "stateTopicFilter"), instance.variables);
    const commandTopic = interpolatePluginTemplate(stringValue(instance.config, "commandTopic"), instance.variables);
    if (!isTopicTemplateValid(filter, true) || !isTopicTemplateValid(commandTopic)) {
      return "A resolved dimmable light MQTT topic is invalid. Check this instance's variables and profile settings.";
    }
    return undefined;
  }

  /** Subscribes to the configured state endpoint. */
  subscriptions(instance: ResolvedPluginInstance): readonly string[] {
    const filter = interpolatePluginTemplate(tileConfigString(instance, "stateTopicFilter"), instance.variables);
    return filter ? [filter] : [];
  }

  /** Converts a reported device level into the manager's normalized 0–100 level. */
  decodeMessage(instance: ResolvedPluginInstance, message: MqttMessageEnvelope): PluginState | undefined {
    const rawLevel = scalarNumber(readPayloadValue(message.payload, tileConfigString(instance, "stateValuePath", "level")));
    if (rawLevel === undefined) return undefined;
    const zeroLevel = tileConfigNumber(instance, "zeroLevel", 0);
    const onLevel = tileConfigNumber(instance, "onLevel", 254);
    const brightness = toPercent(rawLevel, zeroLevel, onLevel);
    return { power: rawLevel > zeroLevel, brightness };
  }

  /** Shows the direct favorite indicator when the reported level is above zero. */
  favoriteStateActive(_instance: ResolvedPluginInstance, state: PluginState): boolean | undefined {
    return typeof state.power === "boolean" ? state.power : undefined;
  }

  /** Toggles the light directly from its favorite shortcut. */
  handleFavoritePress(instance: ResolvedPluginInstance, _panel: Panel, _binding: PanelBinding, state: PluginState, _context: PluginRuntimeContext): PluginFavoritePressResult | undefined {
    return this.setPower(instance, state.power !== true);
  }

  /** Dimmable lights are controlled directly from their home tile and favorite. */
  renderScreen(_instance: ResolvedPluginInstance, _state: PluginState, _screen: string, _context: PluginRuntimeContext): PluginScreen | undefined { return undefined; }

  /** There are no separate plugin page actions for this hardware integration. */
  handleAction(_instance: ResolvedPluginInstance, state: PluginState, _action: string, _context: PluginRuntimeContext): PluginActionResult {
    return { screen: "exit", statePatch: state };
  }

  /** Toggles power, dims with Up/Down, and suppresses the built-in color page. */
  handleHomeTileEvent(instance: ResolvedPluginInstance, panel: Panel, index: number, _button: Panel["settings"]["buttons"][number], message: MqttMessageEnvelope, state: PluginState): PluginHomeTileResult | undefined {
    const suffix = message.topic.slice(`${panel.nodeName}/event/`.length);
    if (suffix !== `item/${index}`) return undefined;
    if (message.payload === "longpress") {
      return {
        page: "home",
        commands: [{ topic: `${panel.nodeName}/cmnd/nextion`, payload: "page page0" }]
      };
    }
    if (message.payload === "toggle") return this.setPower(instance, state.power !== true);
    if (message.payload === "up" || message.payload === "dn") {
      const current = scalarNumber(state.brightness) ?? (state.power === true ? 100 : 0);
      const step = tileConfigNumber(instance, "brightnessStep", 10);
      return this.setBrightness(instance, current + (message.payload === "up" ? step : -step));
    }
    return undefined;
  }

  /** Renders Off, On, or the current brightness below a home tile. */
  renderHomeTileState(_instance: ResolvedPluginInstance, panel: Panel, index: number, _button: Panel["settings"]["buttons"][number], page: "home" | "light" | "level", state: PluginState): readonly PluginCommand[] {
    if (page !== "home") return [];
    const brightness = scalarNumber(state.brightness);
    if (brightness === undefined) return [];
    const label = brightness <= 0 ? "Off" : brightness >= 100 ? "On" : `${Math.round(brightness)} %`;
    return [{ topic: `${panel.nodeName}/cmnd/status`, payload: JSON.stringify({ [index]: { label } }) }];
  }

  private setPower(instance: ResolvedPluginInstance, power: boolean): PluginFavoritePressResult | undefined {
    const zeroLevel = tileConfigNumber(instance, "zeroLevel", 0);
    const onLevel = tileConfigNumber(instance, "onLevel", 254);
    const brightness = power ? 100 : 0;
    const command = this.levelCommand(instance, power ? "onPayloadTemplate" : "offPayloadTemplate", power ? onLevel : zeroLevel, brightness);
    return command ? { commands: [command], statePatch: { power, brightness } } : undefined;
  }

  private setBrightness(instance: ResolvedPluginInstance, requested: number): PluginHomeTileResult | undefined {
    const brightness = clampPercent(requested);
    if (brightness === 0) return this.setPower(instance, false);
    const zeroLevel = tileConfigNumber(instance, "zeroLevel", 0);
    const onLevel = tileConfigNumber(instance, "onLevel", 254);
    const rawLevel = Math.round(mapRange(brightness, 0, 100, zeroLevel, onLevel));
    const command = this.levelCommand(instance, "levelPayloadTemplate", rawLevel, brightness);
    return command ? { commands: [command], statePatch: { power: true, brightness } } : undefined;
  }

  private levelCommand(instance: ResolvedPluginInstance, templateKey: string, rawLevel: number, brightness: number): PluginCommand | undefined {
    return tileCommand(
      instance,
      tileConfigString(instance, "commandTopic"),
      tileConfigString(instance, templateKey),
      {
        value: String(rawLevel),
        levelPercent: String(brightness),
        rampTime: String(tileConfigNumber(instance, "rampTime", 0.5))
      }
    );
  }
}

function stringValue(config: Record<string, PluginConfigValue>, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value : "";
}

function numberValue(config: Record<string, PluginConfigValue>, key: string): number | undefined {
  const value = config[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toPercent(value: number, zeroLevel: number, onLevel: number): number {
  return clampPercent(mapRange(value, zeroLevel, onLevel, 0, 100));
}

function mapRange(value: number, fromMinimum: number, fromMaximum: number, toMinimum: number, toMaximum: number): number {
  if (fromMaximum === fromMinimum) return toMinimum;
  const ratio = Math.max(0, Math.min(1, (value - fromMinimum) / (fromMaximum - fromMinimum)));
  return toMinimum + ratio * (toMaximum - toMinimum);
}

function clampPercent(value: number): number { return Math.round(Math.min(100, Math.max(0, value))); }
