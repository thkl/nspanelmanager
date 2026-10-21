import { Router } from "express";
import { randomUUID } from "node:crypto";
import { normalizePanelSettings, validNodeName } from "../domain/panel-settings.js";
import { defaultPanelSettings, type Panel } from "../types.js";
import type { ConfigStore } from "../services/config-store.js";
import type { MqttRuntime } from "../services/mqtt-runtime.js";
import type { PluginRegistry } from "../features/plugins/plugin-registry.js";

/**
 * Creates the HTTP endpoints for panel profile lifecycle operations.
 *
 * `GET /status` returns in-memory MQTT connectivity, `POST /` creates a profile,
 * `PUT /:id` normalizes and publishes changed settings, `DELETE /:id` removes its
 * associated routes, and `POST /:id/apply` manually resends the profile to
 * firmware. Broker setup and generic MQTT route editing live in separate routers.
 */
export function createPanelRouter(store: ConfigStore, mqttRuntime: MqttRuntime, pluginRegistry: PluginRegistry): Router {
  const router = Router();

  router.get("/status", (_request, response) => response.json({ panels: mqttRuntime.panelConnectionStatuses() }));

  router.post("/", async (request, response) => {
    const name = stringValue(request.body?.name).trim();
    const nodeName = stringValue(request.body?.nodeName).trim();
    if (!name || !validNodeName(nodeName)) return response.status(400).json({ error: "Name and a valid MQTT node name are required." });
    if (store.get().panels.some((panel) => panel.nodeName === nodeName)) return response.status(409).json({ error: "That MQTT node name is already in use." });
    const panel = await store.addPanel({ name, nodeName, settings: defaultPanelSettings(name), nativePluginInstances: {}, panelEventPluginInstances: {} });
    mqttRuntime.syncSubscriptions();
    response.status(201).json({ panel });
  });

  router.put("/:id", async (request, response) => {
    const input = request.body as Partial<Panel>;
    const current = store.get().panels.find((panel) => panel.id === request.params.id);
    if (!current) return response.status(404).json({ error: "Panel not found." });
    const name = stringValue(input.name).trim();
    const nodeName = stringValue(input.nodeName).trim();
    if (!name || !validNodeName(nodeName)) return response.status(400).json({ error: "Name and a valid MQTT node name are required." });
    if (store.get().panels.some((panel) => panel.id !== current.id && panel.nodeName === nodeName)) return response.status(409).json({ error: "That MQTT node name is already in use." });
    const nativePluginInstances = normalizeNativePluginInstances(input.nativePluginInstances === undefined ? current.nativePluginInstances : input.nativePluginInstances);
    for (const [pageId, instanceId] of Object.entries(nativePluginInstances)) {
      const instance = store.get().pluginInstances.find((item) => item.id === instanceId);
      const profile = instance && store.get().pluginProfiles.find((item) => item.id === instance.pluginProfileId);
      const definition = profile && pluginRegistry.get(profile.pluginId);
      if (!instance || !definition || definition.nativePanelPage !== pageId) {
        return response.status(400).json({ error: `Choose a registered plugin instance that supports the '${pageId}' native page.` });
      }
    }
    const panelEventPluginInstances = normalizeNativePluginInstances(input.panelEventPluginInstances === undefined ? current.panelEventPluginInstances : input.panelEventPluginInstances);
    for (const [pluginId, instanceId] of Object.entries(panelEventPluginInstances)) {
      const instance = store.get().pluginInstances.find((item) => item.id === instanceId);
      const profile = instance && store.get().pluginProfiles.find((item) => item.id === instance.pluginProfileId);
      const definition = profile && pluginRegistry.get(profile.pluginId);
      if (!instance || !definition?.panelEventObserver || definition.id !== pluginId) {
        return response.status(400).json({ error: `Choose an instance of the '${pluginId}' plugin, which must support panel event handling.` });
      }
    }
    const settings = normalizePanelSettings(input.settings, name);
    for (const [index, button] of settings.buttons.entries()) {
      if (!button.pluginInstanceId) {
        continue;
      }
      const instance = store.get().pluginInstances.find((item) => item.id === button.pluginInstanceId);
      const profile = instance && store.get().pluginProfiles.find((item) => item.id === instance.pluginProfileId);
      const definition = profile && pluginRegistry.get(profile.pluginId);
      if (!instance || !definition?.homeTileType) {
        return response.status(400).json({ error: `Choose a registered light or cover plugin instance for main button ${index + 1}.` });
      }
      if (button.mode === 1 && definition.homeTileType !== "cover") {
        return response.status(400).json({ error: `Main button ${index + 1} uses the level page and must be assigned to a cover plugin.` });
      }
    }
    const panel: Panel = { ...current, name, nodeName, settings, nativePluginInstances, panelEventPluginInstances };
    await store.update((config) => { config.panels = config.panels.map((item) => item.id === current.id ? panel : item); });
    const published = mqttRuntime.publishPanelSettings(panel);
    await mqttRuntime.refreshNativePanel(panel);
    mqttRuntime.syncSubscriptions();
    response.json({ panel, published, topic: `${panel.nodeName}/cmnd/settings` });
  });

  router.delete("/:id", async (request, response) => {
    const id = request.params.id;
    if (!store.get().panels.some((panel) => panel.id === id)) return response.status(404).json({ error: "Panel not found." });
    await store.update((config) => {
      config.panels = config.panels.filter((panel) => panel.id !== id);
      config.routes = config.routes.filter((route) => route.panelId !== id);
      config.panelBindings = config.panelBindings.filter((binding) => binding.panelId !== id);
    });
    await mqttRuntime.removePanelRuntimeState(id);
    mqttRuntime.syncSubscriptions();
    response.status(204).end();
  });

  router.post("/:id/apply", (request, response) => {
    const panel = store.get().panels.find((item) => item.id === request.params.id);
    if (!panel) return response.status(404).json({ error: "Panel not found." });
    if (!mqttRuntime.publishPanelSettings(panel, true)) return response.status(503).json({ error: "The MQTT broker is not connected." });
    response.json({ published: true, topic: `${panel.nodeName}/cmnd/settings` });
  });

  return router;
}

function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }

function normalizeNativePluginInstances(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return Object.fromEntries(Object.entries(input).filter((entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(entry[1].trim())));
}
