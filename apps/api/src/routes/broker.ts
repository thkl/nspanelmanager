import { Router } from "express";
import type { ConfigStore } from "../services/config-store.js";
import type { MqttRuntime } from "../services/mqtt-runtime.js";
import type { PluginRegistry } from "../features/plugins/plugin-registry.js";
import type { BrokerSettings } from "../types.js";
import { presentPluginProfile } from "../features/plugins/plugin-profile-utils.js";

/**
 * Creates endpoints for the manager's single broker connection.
 *
 * Broker credentials are persisted locally but never included in the public
 * configuration response. An empty password leaves the current secret intact,
 * allowing the UI to edit a broker without retrieving its stored credential.
 */
export function createBrokerRouter(store: ConfigStore, mqttRuntime: MqttRuntime, pluginRegistry: PluginRegistry): Router {
  const router = Router();

  router.put("/", async (request, response) => {
    const input = request.body as Partial<BrokerSettings>;
    const previous = store.get().broker;
    const url = stringValue(input.url).trim();
    if (url && !validBrokerUrl(url)) return response.status(400).json({ error: "Use an mqtt://, mqtts://, ws://, or wss:// URL without embedded credentials; enter login details in their separate fields." });
    await store.update((config) => {
      config.broker = {
        url,
        username: stringValue(input.username),
        password: typeof input.password === "string" && input.password ? input.password : previous.password
      };
    }, {
      actor: request.authUser?.email ?? "unknown",
      summary: "MQTT broker settings changed"
    });
    await mqttRuntime.reconnect();
    response.json({ config: publicConfig(store.get(), pluginRegistry), mqtt: mqttRuntime.status() });
  });

  return router;
}

function validBrokerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["mqtt:", "mqtts:", "ws:", "wss:"].includes(url.protocol) && !url.username && !url.password;
  }
  catch { return false; }
}

function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }

function publicConfig(config: ReturnType<ConfigStore["get"]>, pluginRegistry: PluginRegistry) {
  const { password, ...broker } = config.broker;
  const { bearerToken, password: httpPassword, ...httpLogTransport } = config.httpLogTransport;
  return {
    ...config,
    broker: { ...broker, passwordConfigured: Boolean(password) },
    httpLogTransport: {
      ...httpLogTransport,
      bearerTokenConfigured: Boolean(bearerToken),
      passwordConfigured: Boolean(httpPassword)
    },
    pluginProfiles: config.pluginProfiles.map((profile) => presentPluginProfile(profile, pluginRegistry))
  };
}
