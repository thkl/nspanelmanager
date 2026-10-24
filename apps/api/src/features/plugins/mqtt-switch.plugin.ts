import type { Panel, PanelBinding, PluginConfigValue, ResolvedPluginInstance } from "../../types.js";
import type { MqttMessageEnvelope, PluginActionResult, PluginCommand, PluginConfigField, PluginDefinition, PluginFavoritePressResult, PluginHomeTileResult, PluginRuntimeContext, PluginScreen, PluginState } from "./plugin-contract.js";
import { isTopicTemplateValid, readPayloadValue, scalarPower, tileConfigString } from "./home-tile-utils.js";
import { interpolatePluginTemplate } from "./plugin-variables.js";

/** Controls an MQTT light with state feedback and configurable on/off commands. */
export class MqttSwitchPlugin implements PluginDefinition {
  readonly id = "mqtt-switch";
  readonly name = "MQTT switch light";
  readonly version = 1;
  readonly description = "Toggle a light over MQTT with configurable state and on/off payloads, without brightness or color controls.";
  readonly capabilities = ["mqtt", "light", "home-tile", "favorite-toggle"];
  readonly favoriteFlow = true;
  readonly homeTileType = "light" as const;
  readonly configSchema: readonly PluginConfigField[] = [
    { key: "stateTopicFilter", label: "State topic filter", type: "text", required: true, defaultValue: "zigbee2mqtt/{{device}}", help: "MQTT topic that reports the light state. Use {{device}} or other instance variables when needed." },
    { key: "stateValuePath", label: "State value path", type: "text", defaultValue: "state", help: "Dot path to the state in a JSON payload. Leave blank when the payload itself is the state." },
    { key: "stateOnValue", label: "Reported ON value", type: "text", required: true, defaultValue: "ON", help: "Value received from the state topic when the light is on." },
    { key: "stateOffValue", label: "Reported OFF value", type: "text", required: true, defaultValue: "OFF", help: "Value received from the state topic when the light is off." },
    { key: "commandTopic", label: "Command topic", type: "text", required: true, defaultValue: "zigbee2mqtt/{{device}}/set", help: "MQTT topic used by both on and off commands." },
    { key: "onPayload", label: "ON command payload", type: "textarea", defaultValue: "ON", help: "Sent exactly as entered when toggling the light on. JSON payloads are supported." },
    { key: "offPayload", label: "OFF command payload", type: "textarea", defaultValue: "OFF", help: "Sent exactly as entered when toggling the light off. JSON payloads are supported." }
  ];

  /** Validates the state filter, command topic, and distinct reported state values. */
  validateConfig(config: Record<string, PluginConfigValue>): string | undefined {
    if (!isTopicTemplateValid(stringValue(config, "stateTopicFilter"), true)) return "Enter a valid MQTT light state topic filter.";
    if (!isTopicTemplateValid(stringValue(config, "commandTopic"))) return "Enter a valid MQTT light command topic.";
    const onValue = normalizeStateValue(stringValue(config, "stateOnValue"));
    const offValue = normalizeStateValue(stringValue(config, "stateOffValue"));
    if (!onValue || !offValue) return "Configure both reported ON and OFF values.";
    if (onValue === offValue) return "Reported ON and OFF values must be different.";
    return undefined;
  }

  /** Checks required instance variables and validates resolved MQTT topics. */
  validateInstance(instance: ResolvedPluginInstance): string | undefined {
    for (const key of ["stateTopicFilter", "commandTopic"]) {
      for (const [, name] of stringValue(instance.config, key).matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) {
        if (!instance.variables[name]?.trim()) return `Set the '${name}' variable on this light instance.`;
      }
    }
    const filter = interpolatePluginTemplate(stringValue(instance.config, "stateTopicFilter"), instance.variables);
    const commandTopic = interpolatePluginTemplate(stringValue(instance.config, "commandTopic"), instance.variables);
    if (!isTopicTemplateValid(filter, true) || !isTopicTemplateValid(commandTopic)) {
      return "A resolved light MQTT topic is invalid. Check this instance's variables and profile settings.";
    }
    return undefined;
  }

  /** Subscribes to the configured state endpoint. */
  subscriptions(instance: ResolvedPluginInstance): readonly string[] {
    const filter = interpolatePluginTemplate(tileConfigString(instance, "stateTopicFilter"), instance.variables);
    return filter ? [filter] : [];
  }

  /** Decodes configured state values and common ON/OFF encodings. */
  decodeMessage(instance: ResolvedPluginInstance, message: MqttMessageEnvelope): PluginState | undefined {
    const value = readPayloadValue(message.payload, tileConfigString(instance, "stateValuePath", "state"));
    const normalized = normalizeStateValue(value);
    if (!normalized) return undefined;
    if (normalized === normalizeStateValue(tileConfigString(instance, "stateOnValue", "ON"))) return { power: true };
    if (normalized === normalizeStateValue(tileConfigString(instance, "stateOffValue", "OFF"))) return { power: false };
    const commonValue = scalarPower(value);
    return commonValue === undefined ? undefined : { power: commonValue };
  }

  /** Shows whether a directly assigned favorite controls an on light. */
  favoriteStateActive(_instance: ResolvedPluginInstance, state: PluginState): boolean | undefined {
    return typeof state.power === "boolean" ? state.power : undefined;
  }

  /** Turns the light on or off directly from its favorite shortcut. */
  handleFavoritePress(instance: ResolvedPluginInstance, _panel: Panel, _binding: PanelBinding, state: PluginState, _context: PluginRuntimeContext): PluginFavoritePressResult | undefined {
    return this.setPower(instance, state.power !== true);
  }

  /** Simple switch lights do not open an information screen from a favorite. */
  renderScreen(_instance: ResolvedPluginInstance, _state: PluginState, _screen: string, _context: PluginRuntimeContext): PluginScreen | undefined { return undefined; }

  /** There are no page buttons for this on/off-only integration. */
  handleAction(_instance: ResolvedPluginInstance, state: PluginState, _action: string, _context: PluginRuntimeContext): PluginActionResult {
    return { screen: "exit", statePatch: state };
  }

  /** Handles toggle-only home tile presses and prevents opening a color page. */
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
    if (message.payload === "up") return this.setPower(instance, true);
    if (message.payload === "dn") return this.setPower(instance, false);
    return undefined;
  }

  /** Publishes the state label for a light's home tile. */
  renderHomeTileState(_instance: ResolvedPluginInstance, panel: Panel, index: number, _button: Panel["settings"]["buttons"][number], page: "home" | "light" | "level", state: PluginState): readonly PluginCommand[] {
    if (page !== "home" || typeof state.power !== "boolean") return [];
    const label = state.power ? "On" : "Off";
    return [{ topic: `${panel.nodeName}/cmnd/status`, payload: JSON.stringify({ [index]: { label } }) }];
  }

  private setPower(instance: ResolvedPluginInstance, power: boolean): PluginFavoritePressResult | undefined {
    const topic = interpolatePluginTemplate(tileConfigString(instance, "commandTopic"), instance.variables);
    if (!isTopicTemplateValid(topic)) return undefined;
    return {
      commands: [{ topic, payload: tileConfigString(instance, power ? "onPayload" : "offPayload") }],
      statePatch: { power }
    };
  }
}

function stringValue(config: Record<string, PluginConfigValue>, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value : "";
}

function normalizeStateValue(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim().toLowerCase();
  if (typeof value === "boolean" || typeof value === "number") return String(value).toLowerCase();
  return undefined;
}
