import { randomUUID } from "node:crypto";
import { Router } from "express";
import { normalizePanelSettings, validNodeName } from "../domain/panel-settings.js";
import { defaultPanelSettings, type Panel } from "../types.js";
import type { ConfigStore } from "../services/config-store.js";
import type { MqttRuntime } from "../services/mqtt-runtime.js";
import type { PluginRegistry } from "../features/plugins/plugin-registry.js";
import { panelBootstrapTopicRoot, panelTopicRoot } from "../domain/panel-topics.js";

/**
 * Creates the HTTP endpoints for panel profile lifecycle operations.
 *
 * `GET /status` returns in-memory MQTT connectivity, `POST /` creates a profile,
 * `PUT /:id` normalizes and publishes changed settings, `POST /:id/copy-settings`
 * copies a saved profile onto another panel while retaining its identity,
 * `DELETE /:id` removes its associated routes, and `POST /:id/apply` manually
 * resends the profile to firmware. Broker setup and generic MQTT route editing
 * live in separate routers.
 */
export function createPanelRouter(store: ConfigStore, mqttRuntime: MqttRuntime, pluginRegistry: PluginRegistry): Router {
  const router = Router();

  router.get("/status", (_request, response) => response.json({ panels: mqttRuntime.panelConnectionStatuses() }));

  router.post("/discover", (_request, response) => {
    if (!mqttRuntime.requestPanelDiscovery()) return response.status(503).json({ error: "The MQTT broker is not connected." });
    response.json({ requested: true });
  });

  router.post("/", async (request, response) => {
    const name = stringValue(request.body?.name).trim();
    const nodeName = stringValue(request.body?.nodeName).trim();
    const macInput = request.body?.macAddress;
    const macAddress = macInput === undefined || macInput === null || macInput === "" ? undefined : normalizeMacAddress(macInput);
    if (!name || !validNodeName(nodeName)) return response.status(400).json({ error: "Name and a valid MQTT node name are required." });
    if (macInput !== undefined && macInput !== null && macInput !== "" && !macAddress) return response.status(400).json({ error: "Enter a valid 12-character MAC address." });
    if (store.get().panels.some((panel) => panel.nodeName === nodeName)) return response.status(409).json({ error: "That MQTT node name is already in use." });
    if (macAddress && store.get().panels.some((panel) => normalizeMacAddress(panel.macAddress) === macAddress)) return response.status(409).json({ error: "That device MAC address is already assigned to a panel." });
    const unifiedFirmware = Boolean(macAddress && /^nspanel-[a-f0-9]{6}$/i.test(nodeName));
    const panel = await store.addPanel({ name, nodeName, ...(macAddress ? { macAddress } : {}), ...(unifiedFirmware ? { unifiedFirmware: true } : {}), settings: defaultPanelSettings(name), nativePluginInstances: {}, panelEventPluginInstances: {}, hardwareButtonPluginInstances: {} });
    mqttRuntime.syncSubscriptions();
    response.status(201).json({ panel });
  });

  router.patch("/:id/identity", async (request, response) => {
    const current = store.get().panels.find((panel) => panel.id === request.params.id);
    if (!current) return response.status(404).json({ error: "Panel not found." });
    const macInput = request.body?.macAddress;
    const macAddress = macInput === null || macInput === "" ? undefined : normalizeMacAddress(macInput);
    if (macInput !== null && macInput !== "" && !macAddress) return response.status(400).json({ error: "Enter a valid 12-character MAC address or clear the assignment." });
    if (macAddress && store.get().panels.some((panel) => panel.id !== current.id && normalizeMacAddress(panel.macAddress) === macAddress)) {
      return response.status(409).json({ error: "That device MAC address is already assigned to another panel." });
    }
    const discoveredUnifiedFirmware = macAddress && mqttRuntime.discoveredPanelStatuses().some((device) => device.macAddress === macAddress && /^nspanel-[a-f0-9]{6}$/i.test(device.name));
    const panel: Panel = { ...current, macAddress, unifiedFirmware: macAddress ? current.unifiedFirmware === true || Boolean(discoveredUnifiedFirmware) : false };
    await store.update((config) => { config.panels = config.panels.map((item) => item.id === current.id ? panel : item); });
    mqttRuntime.syncSubscriptions();
    response.json({ panel });
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
    const hardwareButtonPluginInstances = normalizeHardwareButtonPluginInstances(
      input.hardwareButtonPluginInstances === undefined ? current.hardwareButtonPluginInstances : input.hardwareButtonPluginInstances
    );
    for (const [index, instanceId] of Object.entries(hardwareButtonPluginInstances) as Array<["0" | "1", string]>) {
      const instance = store.get().pluginInstances.find((item) => item.id === instanceId);
      const profile = instance && store.get().pluginProfiles.find((item) => item.id === instance.pluginProfileId);
      const definition = profile && pluginRegistry.get(profile.pluginId);
      if (!instance?.enabled || !definition?.capabilities.includes("favorite-toggle") || !definition.handleFavoritePress) {
        return response.status(400).json({ error: `Choose an enabled toggle-capable plugin instance for physical button ${Number(index) + 1}.` });
      }
    }
    const settings = normalizePanelSettings(input.settings, name);
    for (const index of ["0", "1"] as const) {
      if (hardwareButtonPluginInstances[index]) settings.hwbuttons[index] = 1;
    }
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
    const panel: Panel = { ...current, name, nodeName, settings, nativePluginInstances, panelEventPluginInstances, hardwareButtonPluginInstances };
    await store.update((config) => { config.panels = config.panels.map((item) => item.id === current.id ? panel : item); });
    mqttRuntime.syncSubscriptions();
    const settingsTopicRoot = current.nodeName !== nodeName
      ? current.unifiedFirmware
        ? panelBootstrapTopicRoot({ ...panel, nodeName: current.nodeName, macAddress: current.macAddress })
        : current.nodeName
      : panelTopicRoot(panel);
    const identityAssignment = current.nodeName !== nodeName && current.unifiedFirmware;
    const published = identityAssignment
      ? mqttRuntime.publishPanelIdentityAssignment(panel, settingsTopicRoot)
      : mqttRuntime.publishPanelSettings(panel, false, settingsTopicRoot);
    if (!panel.unifiedFirmware) await mqttRuntime.refreshNativePanel(panel);
    response.json({ panel, published, topic: `${settingsTopicRoot}/cmnd/${identityAssignment ? "identity" : "settings"}` });
  });

  router.post("/:id/copy-settings", async (request, response) => {
    const target = store.get().panels.find((panel) => panel.id === request.params.id);
    if (!target) return response.status(404).json({ error: "Destination panel not found." });
    const sourcePanelId = stringValue(request.body?.sourcePanelId);
    const source = store.get().panels.find((panel) => panel.id === sourcePanelId);
    if (!source) return response.status(404).json({ error: "Source panel not found." });
    if (source.id === target.id) return response.status(400).json({ error: "Choose a different destination panel." });

    const settings = normalizePanelSettings({
      ...source.settings,
      panelname: target.settings.panelname
    }, target.name);
    const panel: Panel = {
      ...target,
      settings,
      nativePluginInstances: structuredClone(source.nativePluginInstances ?? {}),
      panelEventPluginInstances: structuredClone(source.panelEventPluginInstances ?? {}),
      hardwareButtonPluginInstances: structuredClone(source.hardwareButtonPluginInstances ?? {})
    };
    const sourceBindings = store.get().panelBindings.filter((binding) => binding.panelId === source.id);
    const copiedBindings = sourceBindings.map((binding) => ({
      ...binding,
      id: randomUUID(),
      panelId: target.id,
      trigger: structuredClone(binding.trigger)
    }));

    for (const binding of store.get().panelBindings.filter((item) => item.panelId === target.id)) {
      await mqttRuntime.closePanelBinding(target, binding.id);
    }
    const updated = await store.update((config) => {
      config.panels = config.panels.map((item) => item.id === target.id ? panel : item);
      config.panelBindings = [
        ...config.panelBindings.filter((binding) => binding.panelId !== target.id),
        ...copiedBindings
      ];
    });
    mqttRuntime.syncSubscriptions();
    const published = mqttRuntime.publishPanelSettings(panel, true);
    await mqttRuntime.refreshNativePanel(panel);
    response.json({
      panel,
      panelBindings: updated.panelBindings.filter((binding) => binding.panelId === target.id),
      published,
      topic: panelTopicRoot(panel) + "/cmnd/settings"
    });
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
    response.json({ published: true, topic: `${panelTopicRoot(panel)}/cmnd/settings` });
  });

  return router;
}

function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }

function normalizeMacAddress(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/[:-]/g, "").toLowerCase();
  return /^[a-f0-9]{12}$/.test(normalized) ? normalized : undefined;
}

function normalizeNativePluginInstances(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return Object.fromEntries(Object.entries(input).filter((entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(entry[1].trim())));
}

function normalizeHardwareButtonPluginInstances(input: unknown): Partial<Record<"0" | "1", string>> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return Object.fromEntries((["0", "1"] as const).flatMap((index) => {
    const instanceId = (input as Record<string, unknown>)[index];
    return typeof instanceId === "string" && instanceId.trim() ? [[index, instanceId.trim()] as const] : [];
  }));
}
