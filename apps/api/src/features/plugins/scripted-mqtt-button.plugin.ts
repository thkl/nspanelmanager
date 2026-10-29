import type { Panel, PanelBinding, PluginConfigValue, ResolvedPluginInstance } from "../../types.js";
import type { PluginActionResult, PluginCommand, PluginConfigField, PluginDefinition, PluginFavoritePressResult, PluginRuntimeContext, PluginScreen, PluginState } from "./plugin-contract.js";
import { applyScriptDebugLogs, runScriptFunction } from "./script-runtime.js";

const DEFAULT_BUTTON_CODE = `return {
  topic: "example/device/set",
  payload: { action: "press" }
};`;

/** Runs a configured JavaScript action when a panel favorite is pressed. */
export class ScriptedMqttButtonPlugin implements PluginDefinition {
  readonly id = "mqtt-scripted-button";
  readonly name = "Scripted MQTT button";
  readonly version = 1;
  readonly description = "Run a JavaScript function from a panel favorite and publish its returned MQTT topic and payload without opening a screen.";
  readonly capabilities = ["mqtt", "javascript", "favorite-action"];
  readonly favoriteFlow = true;
  readonly configSchema: readonly PluginConfigField[] = [
    {
      key: "buttonPressCode",
      label: "Favorite button script",
      type: "textarea",
      required: true,
      defaultValue: DEFAULT_BUTTON_CODE,
      help: "Runs when this favorite is pressed. Return { topic: \"device/set\", payload: { state: \"ON\" } }; payload may be text or any JSON value. Return null to skip publishing. Read panel details from context.panel, the favorite from context.binding, and instance values from variables or {{variableName}}."
    }
  ];

  /** Ensures an action script is configured and stays within the script limit. */
  validateConfig(config: Record<string, PluginConfigValue>): string | undefined {
    const source = config.buttonPressCode;
    if (typeof source !== "string" || !source.trim()) return "Enter a JavaScript function body for the favorite button.";
    if (source.length > 32_000) return "The favorite button script must be under 32,000 characters.";
    return undefined;
  }

  /** This action plugin does not subscribe to device state topics. */
  subscriptions(_instance: ResolvedPluginInstance): readonly string[] { return []; }

  /** No external state is consumed by this action plugin. */
  decodeMessage(): PluginState | undefined { return undefined; }

  /** Runs the saved script and converts its returned MQTT message to one command. */
  async handleFavoritePress(
    instance: ResolvedPluginInstance,
    _panel: Panel,
    _binding: PanelBinding,
    state: PluginState,
    context: PluginRuntimeContext
  ): Promise<PluginFavoritePressResult | undefined> {
    const source = typeof instance.config.buttonPressCode === "string" ? instance.config.buttonPressCode : "";
    // Button-only scripts return one explicit command; they do not get the page plugin's implicit send helpers.
    const execution = await runScriptFunction(source, undefined, state, context, { publish: false, writeStorage: false });
    applyScriptDebugLogs(execution.effects, context);
    if (execution.value === null) return undefined;
    const output = execution.value;
    if (!isRecord(output) || typeof output.topic !== "string" || !("payload" in output)) {
      throw new Error("The favorite button script must return { topic, payload } or null.");
    }
    const topic = output.topic.trim();
    if (!isPublishableTopic(topic)) throw new Error("The favorite button script returned an invalid MQTT topic.");
    const payload = typeof output.payload === "string" ? output.payload : JSON.stringify(output.payload);
    if (payload === undefined) throw new Error("The favorite button script returned a payload that is not JSON serializable.");
    const command: PluginCommand = { topic, payload };
    return { commands: [command] };
  }

  /** Favorite presses execute the script directly and never open a plugin screen. */
  renderScreen(_instance: ResolvedPluginInstance, _state: PluginState, _screen: string, _context: PluginRuntimeContext): PluginScreen | undefined { return undefined; }

  /** The plugin has no page actions because it does not render a page. */
  handleAction(_instance: ResolvedPluginInstance, state: PluginState, _action: string, _context: PluginRuntimeContext): PluginActionResult {
    return { screen: "exit", statePatch: state };
  }
}

function isPublishableTopic(topic: string): boolean {
  return Boolean(topic.trim()) && !/[+#\u0000]/.test(topic);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
