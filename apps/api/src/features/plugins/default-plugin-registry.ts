import { ScriptedMqttPlugin } from "./scripted-mqtt.plugin.js";
import { PluginRegistry } from "./plugin-registry.js";

/** Creates the built-in integration registry for one manager process. */
export function createDefaultPluginRegistry(): PluginRegistry {
  const registry = new PluginRegistry();
  registry.register(new ScriptedMqttPlugin());
  registry.registerAlias("mqtt-fan", "mqtt-scripted");
  return registry;
}
