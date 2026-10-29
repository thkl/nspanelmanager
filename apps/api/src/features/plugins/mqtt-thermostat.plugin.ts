import type { Panel, PluginConfigValue, ResolvedPluginInstance } from "../../types.js";
import type { MqttMessageEnvelope, PluginActionResult, PluginConfigField, PluginDefinition, PluginNativePanelResult, PluginRuntimeContext, PluginScreen, PluginState } from "./plugin-contract.js";
import { configNumber, configString } from "./plugin-contract.js";
import { interpolatePluginTemplate } from "./plugin-variables.js";

/**
 * Connects external MQTT temperature topics to the firmware's built-in
 * thermostat page. Profiles define topic and payload behavior; per-device
 * instances provide variables such as the Homematic channel ID. The panel
 * runtime calls this integration only for the configured native page and
 * gates state refreshes until the firmware reports that page as open.
 */
export class MqttThermostatPlugin implements PluginDefinition {
  readonly id = "mqtt-thermostat";
  readonly name = "MQTT thermostat";
  readonly version = 1;
  readonly description = "Connect an MQTT thermostat to the NSPanel's built-in thermostat screen. Reuse a profile across devices and set each instance's channel variable when using the default Homematic topics.";
  readonly capabilities = ["mqtt", "native-panel-page", "thermostat"];
  readonly nativePanelPage = "thermostat";
  readonly supportsPanelStateReplay = true;
  readonly configSchema: readonly PluginConfigField[] = [
    { key: "statusTopicFilter", label: "Status topic filter", type: "text", required: true, defaultValue: "ccu/status/{{channel}}/+", help: "Subscribe filter for the device. For the default Homematic topics, add a channel variable to each instance, such as channel = LEQ0999385:2. Put + or # at the end; the Current and Target suffixes replace that final wildcard." },
    { key: "currentTopicSuffix", label: "Current temperature topic suffix", type: "text", required: true, defaultValue: "ACTUAL_TEMPERATURE", help: "Combined with the status topic base. Example: ACTUAL_TEMPERATURE." },
    { key: "targetTopicSuffix", label: "Target temperature topic suffix", type: "text", required: true, defaultValue: "SET_TEMPERATURE", help: "Combined with the status topic base. Example: SET_TEMPERATURE." },
    { key: "requestTopic", label: "Current temperature request topic", type: "text", required: true, defaultValue: "ccu/get/{{channel}}/ACTUAL_TEMPERATURE", help: "Published when the thermostat page opens. The default request payload is {}." },
    { key: "targetRequestTopic", label: "Target temperature request topic (optional)", type: "text", defaultValue: "", help: "Optional request topic for the target value, published when the page opens." },
    { key: "setTopic", label: "Set topic", type: "text", required: true, defaultValue: "ccu/set/{{channel}}/SET_TEMPERATURE", help: "Receives temperature and Auto/Boost payloads." },
    { key: "valuePath", label: "Temperature value path", type: "text", defaultValue: "val", help: "Dot path in a JSON payload. Use val for {\"val\":22.6}; leave blank when the payload itself is a number." },
    { key: "minimum", label: "Minimum temperature", type: "number", defaultValue: 5, help: "Lower bound applied to panel setpoints and Up/Down actions." },
    { key: "maximum", label: "Maximum temperature", type: "number", defaultValue: 30, help: "Upper bound applied to panel setpoints and Up/Down actions." },
    { key: "delta", label: "Up/Down temperature step", type: "number", defaultValue: 0.5, help: "Temperature change for each Up or Down panel action." },
    { key: "requestPayloadTemplate", label: "Request payload template", type: "textarea", defaultValue: "{}", help: "Payload sent to both configured request topics. Instance variables such as {{channel}} are available." },
    { key: "temperaturePayloadTemplate", label: "Set temperature payload template", type: "textarea", defaultValue: "{{value}}", help: "Available values: {{value}}, {{temperature}}, and configured instance variables." },
    { key: "modePayloadTemplate", label: "Mode payload template", type: "textarea", defaultValue: "mode:{{mode}}", help: "Auto and Boost use this template with mode set to auto or boost. Example: mode:auto." }
  ];

  /** Validates topic shapes, topic suffixes, numeric bounds, and command templates. */
  validateConfig(config: Record<string, PluginConfigValue>): string | undefined {
    const statusFilter = configStringFrom(config, "statusTopicFilter");
    const currentSuffix = configStringFrom(config, "currentTopicSuffix");
    const targetSuffix = configStringFrom(config, "targetTopicSuffix");
    if (!validFilterWithVariables(statusFilter) || !/(?:\+|#)$/.test(statusFilter)) return "Status topic filter must be a valid MQTT filter ending in + or #.";
    if (!validSuffix(currentSuffix) || !validSuffix(targetSuffix) || currentSuffix === targetSuffix) return "Current and target suffixes must be different MQTT topic parts without wildcards.";
    if (!validPublishTopicTemplate(configStringFrom(config, "requestTopic"))) return "Enter a valid current temperature request topic.";
    const targetRequest = configStringFrom(config, "targetRequestTopic");
    if (targetRequest && !validPublishTopicTemplate(targetRequest)) return "Enter a valid target temperature request topic or leave it blank.";
    if (!validPublishTopicTemplate(configStringFrom(config, "setTopic"))) return "Enter a valid temperature set topic.";
    const valuePath = configStringFrom(config, "valuePath");
    if (valuePath && !/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(valuePath)) return "Temperature value path must be a dot-separated JSON property path.";

    const minimum = configNumberFrom(config, "minimum");
    const maximum = configNumberFrom(config, "maximum");
    const delta = configNumberFrom(config, "delta");
    if (minimum === undefined || maximum === undefined || delta === undefined || minimum >= maximum || delta <= 0) {
      return "Minimum and maximum must be finite with minimum below maximum, and the Up/Down step must be positive.";
    }
    if (!configStringFrom(config, "requestPayloadTemplate") || !configStringFrom(config, "temperaturePayloadTemplate") || !configStringFrom(config, "modePayloadTemplate")) {
      return "Configure request, temperature, and mode payload templates.";
    }
    return undefined;
  }

  /** Rejects missing topic variables and topics that become invalid after interpolation. */
  validateInstance(instance: ResolvedPluginInstance): string | undefined {
    const fields = ["statusTopicFilter", "currentTopicSuffix", "targetTopicSuffix", "requestTopic", "targetRequestTopic", "setTopic"];
    for (const key of fields) {
      const source = configString(instance, key);
      for (const [, name] of source.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) {
        if (!instance.variables[name]?.trim()) return `Set the '${name}' variable on this thermostat instance before saving.`;
      }
    }

    const topics = temperatureTopics(instance);
    if (!validResolvedFilter(topics.filter)) return "The resolved status topic filter is invalid. Check this instance's topic variables.";
    if (![topics.current, topics.target, topics.request, topics.set, ...(topics.targetRequest ? [topics.targetRequest] : [])].every(validResolvedTopic)) {
      return "A resolved thermostat topic is invalid. Check this instance's topic variables and profile settings.";
    }
    return undefined;
  }

  /** Returns the configured status filter after inserting instance variables. */
  subscriptions(instance: ResolvedPluginInstance): readonly string[] {
    const filter = interpolatePluginTemplate(configString(instance, "statusTopicFilter"), instance.variables);
    return filter ? [filter] : [];
  }

  /** Decodes a current or target value from the configured MQTT status topic. */
  decodeMessage(instance: ResolvedPluginInstance, message: MqttMessageEnvelope): PluginState | undefined {
    const topics = temperatureTopics(instance);
    // The wildcard subscription may include unrelated devices, so only resolved current/target topics update state.
    const key = message.topic === topics.current ? "currentTemperature" : message.topic === topics.target ? "targetTemperature" : undefined;
    if (!key) return undefined;
    const value = readTemperatureValue(message.payload, configString(instance, "valuePath", "val"));
    return value === undefined ? undefined : { [key]: value };
  }

  /** Opens from the built-in start-screen convention; favorite bindings are not used for this page. */
  startScreen(_instance: ResolvedPluginInstance): string { return "thermostat"; }

  /** This integration uses the firmware's native page and does not render a universal info screen. */
  renderScreen(_instance: ResolvedPluginInstance, _state: PluginState, _screen: string, _context: PluginRuntimeContext): PluginScreen | undefined { return undefined; }

  /** Native screen actions arrive through MQTT events instead of info-page buttons. */
  handleAction(_instance: ResolvedPluginInstance, state: PluginState, _action: string, _context: PluginRuntimeContext): PluginActionResult {
    return { screen: "exit", statePatch: state };
  }

  /** Tracks native-page activity using status queries and explicit close markers from the firmware. */
  nativePanelTransition(_instance: ResolvedPluginInstance, panel: Panel, message: MqttMessageEnvelope): "open" | "close" | undefined {
    if (message.topic === `${panel.nodeName}/event/thermostate/status`) {
      if (message.payload === "query" || message.payload === "open") return "open";
      if (message.payload === "close" || message.payload === "exit") return "close";
    }
    if (message.topic === `${panel.nodeName}/event/thermostate/settemp`) return "open";
    return undefined;
  }

  /** Requests device state or maps a native page setpoint/mode action to MQTT. */
  handleNativePanelEvent(instance: ResolvedPluginInstance, panel: Panel, message: MqttMessageEnvelope, state: PluginState): PluginNativePanelResult | void {
    const statusTopic = `${panel.nodeName}/event/thermostate/status`;
    if (message.topic === statusTopic && (message.payload === "query" || message.payload === "open")) {
      const topics = temperatureTopics(instance);
      const payload = template(configString(instance, "requestPayloadTemplate", "{}"), instance, {});
      const commands = [{ topic: topics.request, payload }];
      if (topics.targetRequest) commands.push({ topic: topics.targetRequest, payload });
      return { commands };
    }

    if (message.topic !== `${panel.nodeName}/event/thermostate/settemp`) return undefined;
    const commandTopic = temperatureTopics(instance).set;
    const action = message.payload.trim().toLowerCase();
    if (action === "auto" || action === "boost") {
      return { commands: [{ topic: commandTopic, payload: template(configString(instance, "modePayloadTemplate", "mode:{{mode}}"), instance, { mode: action }) }] };
    }

    const bounds = limits(instance);
    const priorTarget = finiteStateNumber(state.targetTemperature) ?? finiteStateNumber(state.currentTemperature) ?? bounds.minimum;
    const requested = action === "up" ? priorTarget + bounds.delta : action === "dn" ? priorTarget - bounds.delta : Number(action);
    if (!Number.isFinite(requested)) return undefined;
    const value = normalizeTemperature(requested, bounds.minimum, bounds.maximum);
    const payload = template(configString(instance, "temperaturePayloadTemplate", "{{value}}"), instance, { value: String(value), temperature: String(value) });
    return { commands: [{ topic: commandTopic, payload }], statePatch: { targetTemperature: value } };
  }

  /** Sends current and target readings to the panel only while its native page is active. */
  renderNativePanelState(instance: ResolvedPluginInstance, panel: Panel, state: PluginState): readonly { topic: string; payload: string }[] {
    void instance; // Instance-specific topic templates are used for input; thermostat screen command topics are firmware-defined.
    const commands: Array<{ topic: string; payload: string }> = [];
    const current = finiteStateNumber(state.currentTemperature);
    const target = finiteStateNumber(state.targetTemperature);
    if (current !== undefined) commands.push({ topic: `${panel.nodeName}/cmnd/thermostate/current`, payload: JSON.stringify({ temperature: current }) });
    if (target !== undefined) commands.push({ topic: `${panel.nodeName}/cmnd/thermostate/target`, payload: JSON.stringify({ temperature: target }) });
    return commands;
  }

  /** Updates the panel's shared home-screen temperature only when actual temperature changes. */
  renderPanelState(_instance: ResolvedPluginInstance, panel: Panel, state: PluginState, previousState: PluginState, change: PluginState): readonly { topic: string; payload: string }[] {
    if (!Object.hasOwn(change, "currentTemperature")) return [];
    const current = finiteStateNumber(state.currentTemperature);
    if (current === undefined || Object.is(current, finiteStateNumber(previousState.currentTemperature))) return [];
    return [{ topic: `${panel.nodeName}/cmnd/temperature/current`, payload: String(current) }];
  }

  /** Restores cached readings to the panel and requests current source values after startup. */
  renderPanelRestartState(instance: ResolvedPluginInstance, panel: Panel, state: PluginState): readonly { topic: string; payload: string }[] {
    const commands: Array<{ topic: string; payload: string }> = [
      ...this.renderNativePanelState(instance, panel, state),
      ...this.renderPanelState(instance, panel, state, {}, { currentTemperature: state.currentTemperature })
    ];
    const topics = temperatureTopics(instance);
    const payload = template(configString(instance, "requestPayloadTemplate", "{}"), instance, {});
    commands.push({ topic: topics.request, payload });
    if (topics.targetRequest) commands.push({ topic: topics.targetRequest, payload });
    return commands;
  }
}

function configStringFrom(config: Record<string, PluginConfigValue>, key: string): string {
  return typeof config[key] === "string" ? config[key] as string : "";
}

function configNumberFrom(config: Record<string, PluginConfigValue>, key: string): number | undefined {
  const value = config[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function validFilterWithVariables(filter: string): boolean {
  const normalized = filter.replace(/\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}/g, "variable");
  if (!normalized || normalized.includes("\u0000")) return false;
  const levels = normalized.split("/");
  return levels.every((level, index) => level.includes("#") ? level === "#" && index === levels.length - 1 : !level.includes("+") || level === "+");
}

function validPublishTopicTemplate(topic: string): boolean {
  const normalized = topic.replace(/\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}/g, "variable");
  return Boolean(normalized.trim()) && !/[+#\u0000]/.test(normalized);
}

function validResolvedFilter(filter: string): boolean {
  if (!filter || filter.includes("\u0000") || filter.includes("//")) return false;
  const levels = filter.split("/");
  return levels.every((level, index) => level.includes("#") ? level === "#" && index === levels.length - 1 : !level.includes("+") || level === "+");
}

function validResolvedTopic(topic: string): boolean {
  return Boolean(topic.trim()) && !/[+#\u0000]/.test(topic) && !topic.includes("//");
}

function validSuffix(value: string): boolean { return Boolean(value.trim()) && !/[+#\u0000]/.test(value) && !value.startsWith("/") && !value.endsWith("/"); }

function temperatureTopics(instance: ResolvedPluginInstance): { filter: string; current: string; target: string; request: string; targetRequest: string; set: string } {
  const filter = interpolatePluginTemplate(configString(instance, "statusTopicFilter"), instance.variables);
  const suffixIndex = filter.lastIndexOf("/");
  const base = suffixIndex >= 0 && ["+", "#"].includes(filter.slice(suffixIndex + 1)) ? filter.slice(0, suffixIndex + 1) : "";
  return {
    filter,
    current: base + interpolatePluginTemplate(configString(instance, "currentTopicSuffix"), instance.variables),
    target: base + interpolatePluginTemplate(configString(instance, "targetTopicSuffix"), instance.variables),
    request: interpolatePluginTemplate(configString(instance, "requestTopic"), instance.variables),
    targetRequest: interpolatePluginTemplate(configString(instance, "targetRequestTopic"), instance.variables),
    set: interpolatePluginTemplate(configString(instance, "setTopic"), instance.variables)
  };
}

function readTemperatureValue(payload: string, valuePath: string): number | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(payload); } catch { return undefined; }
  const value = valuePath ? valuePath.split(".").reduce<unknown>((current, part) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[part];
  }, parsed) : parsed;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function limits(instance: ResolvedPluginInstance): { minimum: number; maximum: number; delta: number } {
  return {
    minimum: configNumber(instance, "minimum", 5),
    maximum: configNumber(instance, "maximum", 30),
    delta: configNumber(instance, "delta", 0.5)
  };
}

function normalizeTemperature(value: number, minimum: number, maximum: number): number {
  return Number(Math.min(maximum, Math.max(minimum, value)).toFixed(2));
}

function finiteStateNumber(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }

function template(source: string, instance: ResolvedPluginInstance, replacements: Record<string, string>): string {
  return interpolatePluginTemplate(source, { ...instance.variables, ...replacements });
}
