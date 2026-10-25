import type { Panel, PluginConfigValue, ResolvedPluginInstance } from "../../types.js";
import type { MqttMessageEnvelope, PluginActionResult, PluginConfigField, PluginDefinition, PluginFavoritePanelPageResult, PluginHomeTileResult, PluginRuntimeContext, PluginScreen, PluginState } from "./plugin-contract.js";
import { isTopicTemplateValid, readPayloadValue, scalarNumber, tileCommand, tileConfigNumber, tileConfigString } from "./home-tile-utils.js";
import { interpolatePluginTemplate } from "./plugin-variables.js";

/** Connects a generic MQTT cover or blind to a panel home tile and built-in level page. */
export class MqttCoverPlugin implements PluginDefinition {
  readonly id = "mqtt-cover";
  readonly name = "MQTT cover / blind";
  readonly version = 1;
  readonly description = "Control MQTT blinds and covers from a panel tile or favorite, including the built-in level page and slider.";
  readonly capabilities = ["mqtt", "cover", "home-tile", "favorite-page", "level-page"];
  readonly favoriteFlow = true;
  readonly favoritePanelPage = "level" as const;
  readonly homeTileType = "cover" as const;
  readonly configSchema: readonly PluginConfigField[] = [
    { key: "statusTopicFilter", label: "Status topic filter", type: "text", required: true, defaultValue: "zigbee2mqtt/{{device}}", help: "MQTT filter that reports position or state. Use instance variables such as {{device}}." },
    { key: "positionValuePath", label: "Position value path", type: "text", defaultValue: "position", help: "Dot path to the numeric position (0–100). Leave blank when the payload is a number." },
    { key: "requestTopic", label: "Request topic (optional)", type: "text", defaultValue: "", help: "Published when the panel opens the level page." },
    { key: "requestPayloadTemplate", label: "Request payload template", type: "textarea", defaultValue: "{}", help: "Supports instance variables such as {{device}}." },
    { key: "setTopic", label: "Set position topic", type: "text", required: true, defaultValue: "zigbee2mqtt/{{device}}/set", help: "Receives the slider position and preset values." },
    { key: "positionPayloadTemplate", label: "Set position payload template", type: "textarea", defaultValue: "{\"position\":{{value}}}", help: "Available value: {{value}} from the level slider or a preset button." },
    { key: "openPayloadTemplate", label: "Open payload template", type: "textarea", defaultValue: "{\"state\":\"OPEN\"}", help: "Published when the home tile emits an up action or toggles an already closed blind." },
    { key: "closePayloadTemplate", label: "Close payload template", type: "textarea", defaultValue: "{\"state\":\"CLOSE\"}", help: "Published when the home tile emits a down action or toggles an open blind." },
    { key: "stopPayloadTemplate", label: "Stop payload template", type: "textarea", defaultValue: "{\"state\":\"STOP\"}", help: "Optional stop command; leave empty if the device has no stop action." },
    { key: "delta", label: "Up/Down position step (%)", type: "number", defaultValue: 10, help: "Position change for each Up or Down tile action." },
    { key: "minimum", label: "Closed position", type: "number", defaultValue: 0, help: "Numeric position sent for fully closed." },
    { key: "maximum", label: "Open position", type: "number", defaultValue: 100, help: "Numeric position sent for fully open." },
    { key: "closedValueLabel", label: "Closed value label", type: "text", defaultValue: "Closed", help: "Displayed below the icon at the minimum cover position." },
    { key: "openValueLabel", label: "Open value label", type: "text", defaultValue: "Open", help: "Displayed below the icon at the maximum cover position." },
    { key: "presets", label: "Level page presets (JSON)", type: "textarea", defaultValue: "[{\"label\":\"Closed\",\"value\":0},{\"label\":\"25%\",\"value\":25},{\"label\":\"50%\",\"value\":50},{\"label\":\"75%\",\"value\":75},{\"label\":\"Open\",\"value\":100}]", help: "Up to eight preset buttons. Each entry has a label and a numeric value." }
  ];

  /** Validates MQTT filters, command topics, position bounds, and level presets. */
  validateConfig(config: Record<string, PluginConfigValue>): string | undefined {
    const filter = stringValue(config, "statusTopicFilter");
    if (!isTopicTemplateValid(filter, true)) return "Enter a valid MQTT status topic filter.";
    if (!isTopicTemplateValid(stringValue(config, "setTopic"))) return "Enter a valid MQTT position command topic.";
    const requestTopic = stringValue(config, "requestTopic");
    if (requestTopic && !isTopicTemplateValid(requestTopic)) return "Enter a valid request topic or leave it blank.";
    const minimum = numberValue(config, "minimum");
    const maximum = numberValue(config, "maximum");
    const delta = numberValue(config, "delta");
    if (minimum === undefined || maximum === undefined || delta === undefined || minimum >= maximum || delta <= 0) {
      return "Closed and open positions must be finite with closed below open, and the position step must be positive.";
    }
    try {
      const presets: unknown = JSON.parse(stringValue(config, "presets"));
      if (!Array.isArray(presets) || presets.length > 8 || presets.some((item) => !isPreset(item))) return "Presets must be a JSON array of up to eight {label, value} entries.";
    } catch { return "Level page presets must be valid JSON."; }
    if (!stringValue(config, "positionPayloadTemplate") || !stringValue(config, "openPayloadTemplate") || !stringValue(config, "closePayloadTemplate")) {
      return "Configure position, open, and close payload templates.";
    }
    return undefined;
  }

  /** Checks configured instance variables and validates the resulting MQTT topics. */
  validateInstance(instance: ResolvedPluginInstance): string | undefined {
    for (const key of ["statusTopicFilter", "requestTopic", "setTopic"]) {
      for (const [, name] of stringValue(instance.config, key).matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) {
        if (!instance.variables[name]?.trim()) return `Set the '${name}' variable on this cover instance.`;
      }
    }
    const filter = interpolatePluginTemplate(stringValue(instance.config, "statusTopicFilter"), instance.variables);
    const setTopic = interpolatePluginTemplate(stringValue(instance.config, "setTopic"), instance.variables);
    const requestTopic = interpolatePluginTemplate(stringValue(instance.config, "requestTopic"), instance.variables);
    if (!isTopicTemplateValid(filter, true) || !isTopicTemplateValid(setTopic) || (requestTopic && !isTopicTemplateValid(requestTopic))) {
      return "A resolved cover MQTT topic is invalid. Check this instance's variables and profile settings.";
    }
    return undefined;
  }

  /** Subscribes to the device's configured state topic filter. */
  subscriptions(instance: ResolvedPluginInstance): readonly string[] {
    const filter = interpolatePluginTemplate(tileConfigString(instance, "statusTopicFilter"), instance.variables);
    return filter ? [filter] : [];
  }

  /** Normalizes an incoming position value to a number from the device payload. */
  decodeMessage(instance: ResolvedPluginInstance, message: MqttMessageEnvelope): PluginState | undefined {
    const position = scalarNumber(readPayloadValue(message.payload, tileConfigString(instance, "positionValuePath", "position")));
    if (position === undefined) return undefined;
    return { position: clampPosition(instance, position) };
  }

  /** Shows the favorite indicator when the cover is above its configured closed position. */
  favoriteStateActive(instance: ResolvedPluginInstance, state: PluginState): boolean | undefined {
    const position = scalarNumber(state.position);
    if (position === undefined) return undefined;
    return clampPosition(instance, position) > tileConfigNumber(instance, "minimum", 0);
  }

  /** Covers use panel home tiles and do not open a universal info screen. */
  startScreen(_instance: ResolvedPluginInstance): string { return "level"; }

  /** This integration renders directly to firmware home and level pages. */
  renderScreen(_instance: ResolvedPluginInstance, _state: PluginState, _screen: string, _context: PluginRuntimeContext): PluginScreen | undefined { return undefined; }

  /** No universal plugin-page buttons are used by this hardware integration. */
  handleAction(_instance: ResolvedPluginInstance, state: PluginState, _action: string, _context: PluginRuntimeContext): PluginActionResult {
    return { screen: "exit", statePatch: state };
  }

  /** Opens the level page from a favorite, clearing stale topic routing before sending its presets. */
  openFavoritePanelPage(instance: ResolvedPluginInstance, panel: Panel, binding: { name: string }, state: PluginState): PluginFavoritePanelPageResult {
    const request = this.requestCommand(instance);
    const commands = [
      { topic: `${panel.nodeName}/cmnd/goto`, payload: JSON.stringify({ page: "pageLevel" }) },
      this.levelConfigurationCommand(instance, panel, binding.name),
      ...(request ? [request] : []),
      ...this.renderFavoritePanelState(instance, panel, state)
    ];
    return { commands };
  }

  /** Re-sends level presets on every firmware query and translates slider/preset events. */
  handleFavoritePanelEvent(instance: ResolvedPluginInstance, panel: Panel, binding: { name: string }, message: MqttMessageEnvelope, state: PluginState): PluginFavoritePanelPageResult | undefined {
    const suffix = message.topic.slice(`${panel.nodeName}/event/`.length);
    if (/^level\/\d{1,2}$/.test(suffix) && message.payload.trim().toLowerCase() === "query") {
      const request = this.requestCommand(instance);
      return {
        commands: [
          this.levelConfigurationCommand(instance, panel, binding.name),
          ...(request ? [request] : []),
          ...this.renderFavoritePanelState(instance, panel, state)
        ]
      };
    }
    if (!/^level\/set\/\d{1,2}$/.test(suffix)) return undefined;
    const requested = readLevelValue(message.payload);
    if (requested === undefined) return undefined;
    const result = this.publishPosition(instance, requested);
    return result ? { commands: result.commands, statePatch: result.statePatch } : undefined;
  }

  /** Keeps the slider position synchronized while this cover's favorite page is visible. */
  renderFavoritePanelState(_instance: ResolvedPluginInstance, panel: Panel, state: PluginState): readonly { topic: string; payload: string }[] {
    const position = scalarNumber(state.position);
    return position === undefined ? [] : [{ topic: `${panel.nodeName}/cmnd/level/status`, payload: String(Math.round(position)) }];
  }

  /** Handles tile taps, re-sends level page config for every query, and processes slider or preset updates. */
  handleHomeTileEvent(instance: ResolvedPluginInstance, panel: Panel, index: number, button: Panel["settings"]["buttons"][number], message: MqttMessageEnvelope, state: PluginState): PluginHomeTileResult | undefined {
    const suffix = message.topic.slice(`${panel.nodeName}/event/`.length);
    const pageQuery = new RegExp(`^level/${index}$`).exec(suffix);
    if (pageQuery && message.payload.trim().toLowerCase() === "query") {
      const topic = `${panel.nodeName}/cmnd/level/config`;
      const presets = parsePresets(tileConfigString(instance, "presets"));
      // This response is rebuilt for every page query because firmware may clear its level-page config.
      const commands = [{ topic, payload: JSON.stringify({ name: button.label, settings: presets }) }];
      const request = tileCommand(instance, tileConfigString(instance, "requestTopic"), tileConfigString(instance, "requestPayloadTemplate", "{}"));
      if (request) commands.push(request);
      return { page: "level", commands };
    }

    const setEvent = new RegExp(`^level/set/${index}$`).exec(suffix);
    if (setEvent) {
      const rawValue = readLevelValue(message.payload);
      if (rawValue === undefined) return undefined;
      const value = clampPosition(instance, rawValue);
      const command = tileCommand(instance, tileConfigString(instance, "setTopic"), tileConfigString(instance, "positionPayloadTemplate"), { value: String(value) });
      return command ? { commands: [command], statePatch: { position: value } } : undefined;
    }

    const itemEvent = new RegExp(`^item/${index}$`).exec(suffix);
    if (!itemEvent) return undefined;
    const position = scalarNumber(state.position) ?? numberValue(instance.config, "minimum") ?? 0;
    if (message.payload === "toggle") {
      const opening = position <= midpoint(instance);
      const value = opening ? tileConfigNumber(instance, "maximum", 100) : tileConfigNumber(instance, "minimum", 0);
      const payloadTemplate = tileConfigString(instance, opening ? "openPayloadTemplate" : "closePayloadTemplate");
      const command = tileCommand(instance, tileConfigString(instance, "setTopic"), payloadTemplate);
      return command ? { commands: [command], statePatch: { position: value } } : undefined;
    }
    if (message.payload === "up" || message.payload === "dn") {
      const direction = message.payload === "up" ? 1 : -1;
      return this.publishPosition(instance, position + direction * tileConfigNumber(instance, "delta", 10));
    }
    if (message.payload === "stop") {
      const stopPayload = tileConfigString(instance, "stopPayloadTemplate");
      if (!stopPayload.trim()) return undefined;
      const command = tileCommand(instance, tileConfigString(instance, "setTopic"), stopPayload);
      return command ? { commands: [command] } : undefined;
    }
    return undefined;
  }

  /** Shows the cover's latest label on its home tile or position on the level slider. */
  renderHomeTileState(instance: ResolvedPluginInstance, panel: Panel, index: number, _button: Panel["settings"]["buttons"][number], page: "home" | "light" | "level", state: PluginState): readonly { topic: string; payload: string }[] {
    const position = scalarNumber(state.position);
    if (position === undefined) return [];
    if (page === "level") return [{ topic: `${panel.nodeName}/cmnd/level/status`, payload: String(Math.round(position)) }];
    if (page !== "home") return [];
    const bounded = clampPosition(instance, position);
    const minimum = tileConfigNumber(instance, "minimum", 0);
    const maximum = tileConfigNumber(instance, "maximum", 100);
    const label = bounded === minimum
      ? tileConfigString(instance, "closedValueLabel", "Closed")
      : bounded === maximum
        ? tileConfigString(instance, "openValueLabel", "Open")
        : `${Math.round(bounded)} %`;
    return [{ topic: `${panel.nodeName}/cmnd/status`, payload: JSON.stringify({ [index]: { label } }) }];
  }

  private publishPosition(instance: ResolvedPluginInstance, requested: number): PluginHomeTileResult | undefined {
    const value = clampPosition(instance, requested);
    const command = tileCommand(instance, tileConfigString(instance, "setTopic"), tileConfigString(instance, "positionPayloadTemplate"), { value: String(value) });
    return command ? { commands: [command], statePatch: { position: value } } : undefined;
  }

  /** Builds the firmware's eight preset buttons and clears routing left by another level page. */
  private levelConfigurationCommand(instance: ResolvedPluginInstance, panel: Panel, title: string): { topic: string; payload: string } {
    const levelTopic =  instance.variables && instance.variables['device'] ? instance.variables['device'] : ""
    const result = {
      topic: `${panel.nodeName}/cmnd/level/config`,
      payload: JSON.stringify({ name: title || instance.name, settings: parsePresets(tileConfigString(instance, "presets")), levelTopic: levelTopic, topic: "",version: "2" })
    };
    return result;
  }

  /** Builds the optional device request sent whenever a level page opens or refreshes. */
  private requestCommand(instance: ResolvedPluginInstance): { topic: string; payload: string } | undefined {
    return tileCommand(instance, tileConfigString(instance, "requestTopic"), tileConfigString(instance, "requestPayloadTemplate", "{}"));
  }
}

function stringValue(config: Record<string, PluginConfigValue>, key: string, fallback = ""): string {
  const value = config[key];
  return typeof value === "string" ? value : fallback;
}

function numberValue(config: Record<string, PluginConfigValue>, key: string): number | undefined {
  const value = config[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isPreset(value: unknown): value is { label: string; value: number } {
  if (!value || typeof value !== "object") return false;
  const preset = value as Record<string, unknown>;
  return typeof preset.label === "string" && typeof preset.value === "number" && Number.isFinite(preset.value);
}

function parsePresets(source: string): Array<{ label: string; value: number }> {
  try {
    const parsed: unknown = JSON.parse(source);
    return Array.isArray(parsed) ? parsed.filter(isPreset).slice(0, 8) : [];
  } catch { return []; }
}

function readLevelValue(payload: string): number | undefined {
  const value = readPayloadValue(payload, "level");
  return scalarNumber(value) ?? scalarNumber(readPayloadValue(payload, ""));
}

function clampPosition(instance: ResolvedPluginInstance, requested: number): number {
  const minimum = tileConfigNumber(instance, "minimum", 0);
  const maximum = tileConfigNumber(instance, "maximum", 100);
  return Math.round(Math.min(maximum, Math.max(minimum, requested)));
}

function midpoint(instance: ResolvedPluginInstance): number {
  return (tileConfigNumber(instance, "minimum", 0) + tileConfigNumber(instance, "maximum", 100)) / 2;
}
