import type { Panel, PluginConfigValue, ResolvedPluginInstance } from "../../types.js";
import type { MqttMessageEnvelope, PluginActionResult, PluginConfigField, PluginDefinition, PluginHomeTileResult, PluginRuntimeContext, PluginScreen, PluginState } from "./plugin-contract.js";
import { isTopicTemplateValid, readPayloadValue, scalarNumber, scalarPower, tileCommand, tileConfigNumber, tileConfigString } from "./home-tile-utils.js";
import { interpolatePluginTemplate } from "./plugin-variables.js";
import { decodeNextionRgb, XYToRGB } from "./nextion-color-wheel.js";

/** Connects a generic MQTT light to the panel tile and its brightness/color screen. */
export class MqttLightPlugin implements PluginDefinition {
  readonly id = "mqtt-light";
  readonly name = "MQTT light";
  readonly version = 3;
  readonly description = "Control an MQTT light from a panel home tile and the firmware's brightness/color screen.";
  readonly capabilities = ["mqtt", "light", "home-tile", "brightness", "color"];
  readonly homeTileType = "light" as const;
  readonly configSchema: readonly PluginConfigField[] = [
    { key: "statusTopicFilter", label: "Status topic filter", type: "text", required: true, defaultValue: "zigbee2mqtt/{{device}}", help: "MQTT filter that reports the light state. Use instance variables such as {{device}}." },
    { key: "powerValuePath", label: "Power value path", type: "text", defaultValue: "state", help: "Dot path to ON/OFF or true/false. Leave blank when the payload is the value." },
    { key: "brightnessValuePath", label: "Brightness value path", type: "text", defaultValue: "brightness", help: "Dot path to the MQTT brightness value. Leave blank to ignore brightness status. Normalized brightness is available to scripts through plugin.get(\"brightness\") as a percentage." },
    { key: "brightnessMinimum", label: "MQTT brightness minimum", type: "number", defaultValue: 0, help: "Lowest MQTT brightness value. Panel percentages are mapped between this and the maximum (0–255 for Hue/Zigbee2MQTT)." },
    { key: "brightnessMaximum", label: "MQTT brightness maximum", type: "number", defaultValue: 100, help: "Highest MQTT brightness value. Set this to 255 for Hue/Zigbee2MQTT, or use the range required by your light." },
    { key: "colorValuePath", label: "Color value path", type: "text", defaultValue: "color", help: "Dot path to the color value. Leave blank to ignore color status." },
    { key: "hueMinimum", label: "Hue minimum", type: "number", defaultValue: 0, help: "Low end of the device's hue range. RGB converts to 0–360 degrees before mapping; Philips Hue uses 0–255." },
    { key: "hueMaximum", label: "Hue maximum", type: "number", defaultValue: 255, help: "High end of the device's hue range. Use 255 for Philips Hue, or set the range required by your MQTT device." },
    { key: "saturationMinimum", label: "Saturation minimum", type: "number", defaultValue: 0, help: "Low end of the device's saturation range. RGB converts to 0–100% before mapping; Philips Hue uses 0–255." },
    { key: "saturationMaximum", label: "Saturation maximum", type: "number", defaultValue: 255, help: "High end of the device's saturation range. Use 255 for Philips Hue, or set the range required by your MQTT device." },
    { key: "requestTopic", label: "Request topic (optional)", type: "text", defaultValue: "", help: "Published when the light controls screen opens." },
    { key: "requestPayloadTemplate", label: "Request payload template", type: "textarea", defaultValue: "{}", help: "Supports instance variables such as {{device}}." },
    { key: "setTopic", label: "Set topic", type: "text", required: true, defaultValue: "zigbee2mqtt/{{device}}/set", help: "Receives all configured light commands. Separate topics can be used in the templates if needed." },
    { key: "powerPayloadTemplate", label: "Power payload template", type: "textarea", defaultValue: "{\"state\":\"{{value}}\"}", help: "{{value}} is ON or OFF." },
    { key: "brightnessPayloadTemplate", label: "Brightness payload template", type: "textarea", defaultValue: "{\"brightness\":{{value}}}", help: "{{value}} is the MQTT brightness value mapped from the panel's 0–100 percent into the configured MQTT minimum and maximum." },
    { key: "colorPayloadTemplate", label: "Color payload template", type: "textarea", defaultValue: "{\"color\":\"{{value}}\"}", help: "{{value}} contains a non-wheel color string emitted by the firmware color picker." },
    { key: "colorWheelDiameter", label: "Preview wheel diameter", type: "number", defaultValue: 200, help: "Used only by the manager's interactive preview to simulate the panel wheel. The panel itself sends RGB values, so the manager does not use this to decode MQTT events." },
    { key: "colorWheelPayloadTemplate", label: "Color wheel payload template", type: "textarea", defaultValue: "{\"color\":{\"hue\":{{hue}},\"saturation\":{{saturation}}},\"brightness\":{{brightness}},\"transition\":0.5}", help: "Used for the panel's r|g|b color event. {{hue}} and {{saturation}} are converted from RGB into the configured device ranges; {{brightness}} uses the instance's last known brightness. Also available: {{hueDegrees}}, {{hueFraction}}, {{saturationPercent}}, {{saturationFraction}}, {{brightnessPercent}}, {{rgb}}, {{red}}, {{green}}, {{blue}}, and {{value}} (raw r|g|b string)." },
    { key: "scenePayloadTemplate", label: "Color scene payload template", type: "textarea", defaultValue: "{\"scene\":{{button}},\"page\":\"{{page}}\"}", help: "Fallback for the two scene buttons. Optional instance variables named PSET1 and PSET2 override this template with their raw MQTT payloads; other instance variables can be used inside those payload strings." },
    { key: "brightnessStep", label: "Tile brightness step (%)", type: "number", defaultValue: 10, help: "Brightness change for the home tile's Up and Down controls." },
    { key: "zeroValueLabel", label: "0% value label", type: "text", defaultValue: "Off", help: "Displayed below the icon when brightness is zero." },
    { key: "fullValueLabel", label: "100% value label", type: "text", defaultValue: "On", help: "Displayed below the icon when brightness is 100%." }
  ];

  /** Validates status filters, optional request topics, set topics, and brightness steps. */
  validateConfig(config: Record<string, PluginConfigValue>): string | undefined {
    if (!isTopicTemplateValid(stringValue(config, "statusTopicFilter"), true)) return "Enter a valid MQTT light status filter.";
    if (!isTopicTemplateValid(stringValue(config, "setTopic"))) return "Enter a valid MQTT light command topic.";
    const requestTopic = stringValue(config, "requestTopic");
    if (requestTopic && !isTopicTemplateValid(requestTopic)) return "Enter a valid request topic or leave it blank.";
    const step = numberValue(config, "brightnessStep");
    if (step === undefined || step <= 0 || step > 100) return "Brightness step must be greater than 0 and no more than 100.";
    const brightnessRange = readRange(config, "brightnessMinimum", "brightnessMaximum", 0, 100);
    if (!brightnessRange || brightnessRange.minimum < 0) return "MQTT brightness minimum and maximum must be valid numbers, with maximum greater than minimum.";
    const hueRange = readRange(config, "hueMinimum", "hueMaximum", 0, 255);
    if (!hueRange) return "Hue minimum and maximum must be valid numbers, with maximum greater than minimum.";
    const saturationRange = readRange(config, "saturationMinimum", "saturationMaximum", 0, 255);
    if (!saturationRange) return "Saturation minimum and maximum must be valid numbers, with maximum greater than minimum.";
    const wheelDiameter = config.colorWheelDiameter === undefined ? 200 : numberValue(config, "colorWheelDiameter");
    if (wheelDiameter === undefined || wheelDiameter <= 0 || wheelDiameter > 1000) return "Color wheel calculation diameter must be between 1 and 1000.";
    if (!["powerPayloadTemplate", "brightnessPayloadTemplate", "colorPayloadTemplate", "scenePayloadTemplate"].every((key) => stringValue(config, key).trim())) {
      return "Configure power, brightness, color, and scene payload templates.";
    }
    if (config.colorWheelPayloadTemplate !== undefined && !stringValue(config, "colorWheelPayloadTemplate").trim()) return "Configure the color wheel payload template.";
    return undefined;
  }

  /** Checks instance variables and validates the resolved topics before runtime startup. */
  validateInstance(instance: ResolvedPluginInstance): string | undefined {
    for (const key of ["statusTopicFilter", "requestTopic", "setTopic"]) {
      for (const [, name] of stringValue(instance.config, key).matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) {
        if (!instance.variables[name]?.trim()) return `Set the '${name}' variable on this light instance.`;
      }
    }
    const topics = ["statusTopicFilter", "requestTopic", "setTopic"].map((key) => interpolatePluginTemplate(stringValue(instance.config, key), instance.variables));
    if (!isTopicTemplateValid(topics[0], true) || (topics[1] && !isTopicTemplateValid(topics[1])) || !isTopicTemplateValid(topics[2])) {
      return "A resolved light MQTT topic is invalid. Check this instance's variables and profile settings.";
    }
    return undefined;
  }

  /** Subscribes to the instance's configured light status filter. */
  subscriptions(instance: ResolvedPluginInstance): readonly string[] {
    const filter = interpolatePluginTemplate(tileConfigString(instance, "statusTopicFilter"), instance.variables);
    return filter ? [filter] : [];
  }

  /** Normalizes power, brightness, and color values from an incoming MQTT state packet. */
  decodeMessage(instance: ResolvedPluginInstance, message: MqttMessageEnvelope): PluginState | undefined {
    const patch: PluginState = {};
    const power = scalarPower(readPayloadValue(message.payload, tileConfigString(instance, "powerValuePath", "state")));
    const rawBrightness = scalarNumber(readPayloadValue(message.payload, tileConfigString(instance, "brightnessValuePath", "brightness")));
    const brightness = rawBrightness === undefined ? undefined : this.toPanelBrightness(instance, rawBrightness);
    const color = readPayloadValue(message.payload, tileConfigString(instance, "colorValuePath", "color"));
    if (power !== undefined) patch.power = power;
    if (brightness !== undefined) {
      patch.brightness = clampBrightness(brightness);
      patch.lastBrightness = patch.brightness;
    }
    if (typeof color === "string") patch.color = color;
    return Object.keys(patch).length ? patch : undefined;
  }

  /** Mirrors the normalized panel percentage into durable per-instance script storage. */
  scriptStorageValues(_instance: ResolvedPluginInstance, state: PluginState): Record<string, unknown> {
    const brightness = scalarNumber(state.lastBrightness) ?? scalarNumber(state.brightness);
    return brightness === undefined ? {} : { brightness: clampBrightness(brightness) };
  }

  /** Shows the favorite indicator when the light reports power on or nonzero brightness. */
  favoriteStateActive(_instance: ResolvedPluginInstance, state: PluginState): boolean | undefined {
    if (typeof state.power === "boolean") return state.power;
    const brightness = scalarNumber(state.brightness);
    return brightness === undefined ? undefined : brightness > 0;
  }

  /** Home tiles launch from their configured tile and do not use universal favorites. */
  startScreen(_instance: ResolvedPluginInstance): string { return "overview"; }

  /** This integration draws through firmware-owned home and color pages. */
  renderScreen(_instance: ResolvedPluginInstance, _state: PluginState, _screen: string, _context: PluginRuntimeContext): PluginScreen | undefined { return undefined; }

  /** No generic plugin-screen actions are used by the firmware light controls. */
  handleAction(_instance: ResolvedPluginInstance, state: PluginState, _action: string, _context: PluginRuntimeContext): PluginActionResult {
    return { screen: "exit", statePatch: state };
  }

  /** Routes home tile input and built-in color-page events to the configured light topics. */
  async handleHomeTileEvent(instance: ResolvedPluginInstance, panel: Panel, index: number, button: Panel["settings"]["buttons"][number], message: MqttMessageEnvelope, state: PluginState, context: PluginRuntimeContext): Promise<PluginHomeTileResult | undefined> {
    const suffix = message.topic.slice(`${panel.nodeName}/event/`.length);
    const tileMatch = new RegExp(`^item/${index}$`).exec(suffix);
    if (tileMatch && message.payload === "longpress") {
      const command = {
        topic: `${panel.nodeName}/cmnd/colorLamp`,
        payload: JSON.stringify({ label: button.label, id: interpolatePluginTemplate(tileConfigString(instance, "setTopic"), instance.variables) })
      };
      const request = tileCommand(instance, tileConfigString(instance, "requestTopic"), tileConfigString(instance, "requestPayloadTemplate", "{}"));
      return { page: "light", commands: request ? [command, request] : [command] };
    }
    if (tileMatch && message.payload === "toggle") return this.togglePower(instance, state);
    if (tileMatch && (message.payload === "up" || message.payload === "dn")) {
      const current = scalarNumber(state.brightness) ?? 0;
      const delta = tileConfigNumber(instance, "brightnessStep", 10) * (message.payload === "up" ? 1 : -1);
      return this.publishBrightness(instance, current + delta);
    }

    if (suffix === "colorLamp" || suffix === "colorLamp/set") {
      const event = recordFromJson(message.payload);
      if (!event) return undefined;
      const configuredTopic = interpolatePluginTemplate(tileConfigString(instance, "setTopic"), instance.variables);
      const requestedTopic = typeof event["topic"] === "string" ? event["topic"].trim() : "";
      if (requestedTopic && requestedTopic !== configuredTopic) return undefined;
      const commandTopic = requestedTopic || configuredTopic;
      if (Object.hasOwn(event, "brightness")) {
        const raw = String(event["brightness"] ?? "").trim();
        if (raw === "+10" || raw === "-10") {
          const current = scalarNumber(state.brightness) ?? 0;
          return this.publishBrightness(instance, current + (raw === "+10" ? 10 : -10), commandTopic);
        }
        if (raw === "PSET1" || raw === "PSET2") {
          const presetPayload = instance.variables[raw];
          if (presetPayload?.trim()) return { commands: [{ topic: commandTopic, payload: interpolatePluginTemplate(presetPayload, instance.variables) }] };
          return this.publishScene(instance, raw === "PSET1" ? 1 : 2, "default", commandTopic);
        }
        const value = scalarNumber(event["brightness"]);
        return value === undefined ? undefined : this.publishBrightness(instance, value, commandTopic);
      }
      if (typeof event["color"] === "string") {
        const rawColor = event["color"];
        const savedBrightness = scalarNumber(await context.storage.get("plugin", "brightness"));
        const brightnessPercent = clampBrightness(scalarNumber(state.lastBrightness) ?? scalarNumber(state.brightness) ?? savedBrightness ?? 100);
        const brightness = this.toMqttBrightness(instance, brightnessPercent);
        const rgb = XYToRGB(rawColor)
        const values: Record<string, string> = {
          rgb: `${rgb.r},${rgb.g},${rgb.b}`,
          brightness: String(brightness), brightnessPercent: String(brightnessPercent)
        }
        const template = tileConfigString(instance, "colorWheelPayloadTemplate", '{"color":{"rgb":"{{rgb}}"},"brightness":{{brightness}},"transition":0.5}');
        const command = tileCommand(instance, commandTopic, template, values);
        return command ? { commands: [command], statePatch: { color: rgb } } : undefined;
      }
    }

    if (suffix === "colorscene") {
      const event = recordFromJson(message.payload);
      const scene = event && scalarNumber(event["button"]);
      const page = event && typeof event["page"] === "string" ? event["page"] : "default";
      if (scene !== undefined) return this.publishScene(instance, scene, page);
    }

    if (suffix === "page/colorlamp") {
      const event = recordFromJson(message.payload);
      if (event?.["page"] === "0") {
        return { page: "home", commands: [{ topic: `${panel.nodeName}/cmnd/nextion`, payload: "page page0" }] };
      }
    }
    return undefined;
  }

  /** Updates the visible label on an active home tile from the latest light state. */
  renderHomeTileState(instance: ResolvedPluginInstance, panel: Panel, index: number, _button: Panel["settings"]["buttons"][number], page: "home" | "light" | "level", state: PluginState): readonly { topic: string; payload: string }[] {
    if (page !== "home") return [];
    const power = typeof state.power === "boolean" ? state.power : undefined;
    const brightness = scalarNumber(state.brightness);
    const currentValue = power === false ? 0 : brightness ?? (power === true ? 100 : undefined);
    if (currentValue === undefined) return [];
    const value = clampBrightness(currentValue);
    const label = value === 0
      ? tileConfigString(instance, "zeroValueLabel", "Off")
      : value === 100
        ? tileConfigString(instance, "fullValueLabel", "On")
        : `${value} %`;
    return [{ topic: `${panel.nodeName}/cmnd/status`, payload: JSON.stringify({ [index]: { label } }) }];
  }

  private togglePower(instance: ResolvedPluginInstance, state: PluginState): PluginHomeTileResult | undefined {
    const value = state.power === true ? "OFF" : "ON";
    const command = tileCommand(instance, tileConfigString(instance, "setTopic"), tileConfigString(instance, "powerPayloadTemplate"), { value });
    return command ? { commands: [command], statePatch: { power: value === "ON" } } : undefined;
  }

  private publishBrightness(instance: ResolvedPluginInstance, requested: number, topic = tileConfigString(instance, "setTopic")): PluginHomeTileResult | undefined {
    const value = clampBrightness(requested);
    const mqttBrightness = this.toMqttBrightness(instance, value);
    const command = tileCommand(instance, topic, tileConfigString(instance, "brightnessPayloadTemplate"), { value: String(mqttBrightness) });
    return command ? { commands: [command], statePatch: { power: value > 0, brightness: value, lastBrightness: value } } : undefined;
  }

  private publishScene(instance: ResolvedPluginInstance, button: number, page: string, topic = tileConfigString(instance, "setTopic")): PluginHomeTileResult | undefined {
    const command = tileCommand(instance, topic, tileConfigString(instance, "scenePayloadTemplate"), { button: String(button), page });
    return command ? { commands: [command] } : undefined;
  }

  /** Converts the panel's 0–100 percent state to the configured MQTT brightness range. */
  private toMqttBrightness(instance: ResolvedPluginInstance, percent: number): number {
    if (hasConfiguredRange(instance.config, "brightnessMinimum", "brightnessMaximum")) {
      return Math.round(mapRange(percent, 0, 100, tileConfigNumber(instance, "brightnessMinimum", 0), tileConfigNumber(instance, "brightnessMaximum", 100)));
    }
    return Math.round(percent / tileConfigNumber(instance, "brightnessFactor", 1));
  }

  /** Converts an incoming MQTT brightness to the panel's 0–100 percent state. */
  private toPanelBrightness(instance: ResolvedPluginInstance, mqttValue: number): number {
    if (hasConfiguredRange(instance.config, "brightnessMinimum", "brightnessMaximum")) {
      return mapRange(mqttValue, tileConfigNumber(instance, "brightnessMinimum", 0), tileConfigNumber(instance, "brightnessMaximum", 100), 0, 100);
    }
    return mqttValue * tileConfigNumber(instance, "brightnessFactor", 1);
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

function readRange(config: Record<string, PluginConfigValue>, minimumKey: string, maximumKey: string, defaultMinimum: number, defaultMaximum: number): { minimum: number; maximum: number } | undefined {
  const minimum = config[minimumKey] === undefined ? defaultMinimum : numberValue(config, minimumKey);
  const maximum = config[maximumKey] === undefined ? defaultMaximum : numberValue(config, maximumKey);
  return minimum !== undefined && maximum !== undefined && maximum > minimum ? { minimum, maximum } : undefined;
}

function hasConfiguredRange(config: Record<string, PluginConfigValue>, minimumKey: string, maximumKey: string): boolean {
  return typeof config[minimumKey] === "number" && typeof config[maximumKey] === "number";
}

function mapRange(value: number, sourceMinimum: number, sourceMaximum: number, targetMinimum: number, targetMaximum: number): number {
  if (sourceMaximum === sourceMinimum) return targetMinimum;
  const ratio = Math.min(1, Math.max(0, (value - sourceMinimum) / (sourceMaximum - sourceMinimum)));
  return targetMinimum + ratio * (targetMaximum - targetMinimum);
}

function formatNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function clampBrightness(value: number): number { return Math.round(Math.min(100, Math.max(0, value))); }

function recordFromJson(payload: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(payload);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}
