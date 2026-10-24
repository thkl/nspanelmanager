import { ScriptedMqttPlugin } from "./scripted-mqtt.plugin.js";
import { ScriptedMqttButtonPlugin } from "./scripted-mqtt-button.plugin.js";
import { PluginRegistry } from "./plugin-registry.js";
import { MqttThermostatPlugin } from "./mqtt-thermostat.plugin.js";
import { OpenMeteoWeatherPlugin } from "./open-meteo-weather.plugin.js";
import { MqttLightPlugin } from "./mqtt-light.plugin.js";
import { MqttSwitchPlugin } from "./mqtt-switch.plugin.js";
import { MqttDimmableLightPlugin } from "./mqtt-dimmable-light.plugin.js";
import { MqttCoverPlugin } from "./mqtt-cover.plugin.js";
import { FavoritesPagePlugin } from "./favorites-page.plugin.js";
import { MqttSonosPlugin } from "./mqtt-sonos.plugin.js";
import { ScreenDimmerPlugin } from "./screen-dimmer.plugin.js";

/** Creates the built-in integration registry for one manager process. */
export function createDefaultPluginRegistry(): PluginRegistry {
  const registry = new PluginRegistry();
  registry.register(new ScriptedMqttPlugin());
  registry.register(new ScriptedMqttButtonPlugin());
  registry.register(new MqttThermostatPlugin());
  registry.register(new OpenMeteoWeatherPlugin());
  registry.register(new MqttLightPlugin());
  registry.register(new MqttSwitchPlugin());
  registry.register(new MqttDimmableLightPlugin());
  registry.register(new MqttCoverPlugin());
  registry.register(new FavoritesPagePlugin());
  registry.register(new MqttSonosPlugin());
  registry.register(new ScreenDimmerPlugin());
  registry.registerAlias("mqtt-fan", "mqtt-scripted");
  return registry;
}
