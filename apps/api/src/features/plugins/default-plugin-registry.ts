import { ScriptedMqttPlugin } from "./scripted-mqtt.plugin.js";
import { PluginRegistry } from "./plugin-registry.js";
import { MqttThermostatPlugin } from "./mqtt-thermostat.plugin.js";
import { OpenMeteoWeatherPlugin } from "./open-meteo-weather.plugin.js";
import { MqttLightPlugin } from "./mqtt-light.plugin.js";
import { MqttCoverPlugin } from "./mqtt-cover.plugin.js";

/** Creates the built-in integration registry for one manager process. */
export function createDefaultPluginRegistry(): PluginRegistry {
  const registry = new PluginRegistry();
  registry.register(new ScriptedMqttPlugin());
  registry.register(new MqttThermostatPlugin());
  registry.register(new OpenMeteoWeatherPlugin());
  registry.register(new MqttLightPlugin());
  registry.register(new MqttCoverPlugin());
  registry.registerAlias("mqtt-fan", "mqtt-scripted");
  return registry;
}
