import { Router } from "express";
import { randomUUID } from "node:crypto";
import { normalizePanelSettings, validNodeName } from "../domain/panel-settings.js";
import { defaultPanelSettings, type Panel } from "../types.js";
import type { ConfigStore } from "../services/config-store.js";
import type { MqttRuntime } from "../services/mqtt-runtime.js";

/**
 * Creates the HTTP endpoints for panel profile lifecycle operations.
 *
 * `POST /` creates a profile, `PUT /:id` normalizes settings, `DELETE /:id`
 * removes its associated routes, and `POST /:id/apply` publishes the profile
 * to firmware. This router owns profile-specific behavior; broker setup and
 * generic MQTT route editing live in separate feature routers.
 */
export function createPanelRouter(store: ConfigStore, mqttRuntime: MqttRuntime): Router {
  const router = Router();

  router.post("/", async (request, response) => {
    const name = stringValue(request.body?.name).trim();
    const nodeName = stringValue(request.body?.nodeName).trim();
    if (!name || !validNodeName(nodeName)) return response.status(400).json({ error: "Name and a valid MQTT node name are required." });
    if (store.get().panels.some((panel) => panel.nodeName === nodeName)) return response.status(409).json({ error: "That MQTT node name is already in use." });
    const panel = await store.addPanel({ name, nodeName, settings: defaultPanelSettings(name) });
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
    const panel: Panel = { ...current, name, nodeName, settings: normalizePanelSettings(input.settings, name) };
    await store.update((config) => { config.panels = config.panels.map((item) => item.id === current.id ? panel : item); });
    mqttRuntime.syncSubscriptions();
    response.json({ panel });
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
    if (!mqttRuntime.publishPanelSettings(panel)) return response.status(503).json({ error: "The MQTT broker is not connected." });
    response.json({ published: true, topic: `${panel.nodeName}/cmnd/settings` });
  });

  return router;
}

function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }
