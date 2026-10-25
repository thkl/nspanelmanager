import { Router } from "express";
import { randomUUID } from "node:crypto";
import type { Panel, PanelBinding, PluginConfigValue, PluginInstance, PluginProfile, ResolvedPluginInstance } from "../../types.js";
import type { ConfigStore } from "../../services/config-store.js";
import type { MqttRuntime } from "../../services/mqtt-runtime.js";
import { pluginConfigSchema, type MqttMessageEnvelope, type PluginDefinition, type PluginRuntimeContext } from "./plugin-contract.js";
import type { PluginRegistry } from "./plugin-registry.js";
import { checkScriptSyntax } from "./script-runtime.js";

/**
 * Exposes plugin discovery, reusable plugin profiles, device instances, and
 * favorite bindings. Plugin schemas drive the Angular editor; profiles hold
 * shared behavior while instances supply their own names and variable values.
 */
export function createPluginsRouter(store: ConfigStore, runtime: MqttRuntime, registry: PluginRegistry): Router {
  const router = Router();

  router.get("/", (_request, response) => response.json({ plugins: registry.list() }));
  router.get("/profiles", (_request, response) => response.json({
    profiles: store.get().pluginProfiles.map((profile) => ({ ...profile, pluginId: registry.canonicalId(profile.pluginId) }))
  }));
  router.get("/instances", (_request, response) => response.json({
    instances: store.get().pluginInstances,
    bindings: store.get().panelBindings
  }));

  router.post("/check-script", async (request, response) => {
    const source = request.body?.source;
    if (typeof source !== "string") return response.status(400).json({ valid: false, error: "Script source must be text." });
    const variables = normalizePluginVariables(request.body?.variables);
    const variablesError = validatePluginVariables(request.body?.variables);
    if (variablesError) return response.status(400).json({ valid: false, error: variablesError });
    const error = await checkScriptSyntax(source, variables);
    response.json(error ? { valid: false,error: error } : { valid: true });
  });

  router.post("/preview", async (request, response) => {
    const definition = registry.get(stringValue(request.body?.pluginId));
    if (!definition) return response.status(400).json({ error: "Choose a registered plugin to preview." });
    const variablesError = validatePluginVariables(request.body?.variables);
    if (variablesError) return response.status(400).json({ error: variablesError });
    const variables = normalizePluginVariables(request.body?.variables);
    const config = normalizePluginConfig(definition, request.body?.config);
    const configError = definition.validateConfig(config);
    if (configError) return response.status(400).json({ error: configError });
    const pageId = stringValue(request.body?.pageId).trim();
    const actionSlot = request.body?.actionSlot;
    const topic = stringValue(request.body?.topic).trim();
    const payload = typeof request.body?.payload === "string" ? request.body.payload : undefined;
    if (!pageId) return response.status(400).json({ error: "Choose a page to preview." });
    if (!hasConfiguredPage(config, pageId)) return response.status(400).json({ error: "That page ID is not configured." });
    if (actionSlot !== undefined && (!Number.isInteger(actionSlot) || actionSlot < 1 || actionSlot > 8)) {
      return response.status(400).json({ error: "Preview button slot must be between 1 and 8." });
    }
    if (!isConcreteMqttTopic(topic)) return response.status(400).json({ error: "Enter a concrete MQTT topic without wildcards." });
    if (payload === undefined) return response.status(400).json({ error: "Enter an MQTT payload as text." });

    const instance: ResolvedPluginInstance = {
      id: `preview-${randomUUID()}`, name: "Page preview", pluginProfileId: "preview-profile",
      pluginId: definition.id, enabled: true, config, variables
    };
    const topicFilters = definition.subscriptions(instance);
    if (topicFilters.length > 0 && !topicFilters.some((filter) => matchesTopicFilter(filter, topic))) {
      return response.status(400).json({ error: "This topic does not match any configured MQTT filter." });
    }
    const message: MqttMessageEnvelope = { topic, payload, qos: 0, retain: false, receivedAt: Date.now() };
    const state = definition.decodeMessage(instance, message) ?? {};
    const debugLogs: string[] = [];
    try {
      const context = createPreviewContext(instance, debugLogs, runtime);
      const action = actionSlot === undefined ? undefined : await definition.handleAction(instance, state, `slot:${pageId}:${actionSlot}`, context);
      const nextPageId = action?.navigation?.screen ?? action?.screen ?? pageId;
      const commands = action?.commands ?? [];
      const screen = nextPageId === "exit" ? undefined : await definition.renderScreen(instance, { ...state, ...action?.statePatch }, nextPageId, context);
      response.json(screen
        ? { pageId: nextPageId, rendered: true, title: screen.title, message: screen.message, buttons: screen.buttons.map((button) => button.label), commands, debugLogs }
        : { pageId: nextPageId, rendered: false, title: "", message: "", buttons: [], commands, debugLogs });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      response.status(422).json({ error: detail });
    }
  });

  router.post("/profiles", async (request, response) => {
    const name = stringValue(request.body?.name).trim();
    const definition = registry.get(stringValue(request.body?.pluginId));
    if (!name || !definition) return response.status(400).json({ error: "A name and registered plugin type are required." });
    const config = normalizePluginConfig(definition, request.body?.config);
    const error = definition.validateConfig(config);
    if (error) return response.status(400).json({ error });
    const startupError = await validateConfiguredScripts(config, {});
    if (startupError) return response.status(400).json({ error: startupError });
    const profile: PluginProfile = { id: randomUUID(), name, pluginId: definition.id, config };
    await store.update((current) => { current.pluginProfiles.push(profile); });
    await runtime.refreshPluginInstances();
    response.status(201).json({ profile });
  });

  router.put("/profiles/:id", async (request, response) => {
    const current = store.get().pluginProfiles.find((item) => item.id === request.params.id);
    if (!current) return response.status(404).json({ error: "Plugin not found." });
    const previousDefinition = registry.get(current.pluginId);
    const name = stringValue(request.body?.name).trim();
    const definition = registry.get(stringValue(request.body?.pluginId));
    if (!name || !definition) return response.status(400).json({ error: "A name and registered plugin type are required." });
    const config = normalizePluginConfig(definition, request.body?.config);
    const error = definition.validateConfig(config);
    if (error) return response.status(400).json({ error });
    const startupError = await validateConfiguredScripts(config, {});
    if (startupError) return response.status(400).json({ error: startupError });
    const profile: PluginProfile = { ...current, name, pluginId: definition.id, config };
    for (const instance of store.get().pluginInstances.filter((item) => item.pluginProfileId === profile.id)) {
      const error = definition.validateInstance?.({ ...instance, pluginId: definition.id, config });
      if (error) return response.status(400).json({ error: `Instance '${instance.name}': ${error}` });
    }
    await store.update((managerConfig) => {
      managerConfig.pluginProfiles = managerConfig.pluginProfiles.map((item) => item.id === profile.id ? profile : item);
    });
    await runtime.refreshPluginInstances();
    if (previousDefinition?.nativePanelSharedInstances || definition.nativePanelSharedInstances) publishSharedNativePageSettings(store, runtime);
    response.json({ profile });
  });

  router.delete("/profiles/:id", async (request, response) => {
    const profileId = request.params.id;
    if (!store.get().pluginProfiles.some((item) => item.id === profileId)) return response.status(404).json({ error: "Plugin not found." });
    if (store.get().pluginInstances.some((item) => item.pluginProfileId === profileId)) {
      return response.status(409).json({ error: "Remove or reassign this plugin's instances before deleting it." });
    }
    await store.update((config) => { config.pluginProfiles = config.pluginProfiles.filter((item) => item.id !== profileId); });
    response.status(204).end();
  });

  router.post("/instances", async (request, response) => {
    const name = stringValue(request.body?.name).trim();
    const pluginProfileId = stringValue(request.body?.pluginProfileId);
    const profile = store.get().pluginProfiles.find((item) => item.id === pluginProfileId);
    if (!name || !profile) return response.status(400).json({ error: "A name and saved plugin are required." });
    const variablesError = validatePluginVariables(request.body?.variables);
    if (variablesError) return response.status(400).json({ error: variablesError });
    const variables = normalizePluginVariables(request.body?.variables);
    const instance: PluginInstance = { id: randomUUID(), name, pluginProfileId, enabled: true, variables };
    const definition = registry.get(profile.pluginId);
    const instanceError = definition?.validateInstance?.({ ...instance, pluginId: definition.id, config: profile.config });
    if (instanceError) return response.status(400).json({ error: instanceError });
    const identityError = validateSharedNativePageInstance(instance, definition, store.get().pluginInstances, store.get().pluginProfiles, registry);
    if (identityError) return response.status(400).json({ error: identityError });
    await store.update((current) => { current.pluginInstances.push(instance); });
    await runtime.refreshPluginInstances();
    if (definition?.nativePanelSharedInstances) publishSharedNativePageSettings(store, runtime);
    response.status(201).json({ instance });
  });

  router.put("/instances/:id", async (request, response) => {
    const current = store.get().pluginInstances.find((item) => item.id === request.params.id);
    if (!current) return response.status(404).json({ error: "Plugin instance not found." });
    const name = stringValue(request.body?.name).trim();
    const enabled = typeof request.body?.enabled === "boolean" ? request.body.enabled : current.enabled;
    const pluginProfileId = request.body?.pluginProfileId === undefined ? current.pluginProfileId : stringValue(request.body.pluginProfileId);
    const profile = store.get().pluginProfiles.find((item) => item.id === pluginProfileId);
    if (!name || !profile) return response.status(400).json({ error: "A name and saved plugin are required." });
    const variablesError = validatePluginVariables(request.body?.variables);
    if (variablesError) return response.status(400).json({ error: variablesError });
    const variables = request.body?.variables === undefined
      ? current.variables
      : normalizePluginVariables(request.body.variables);
    const instance: PluginInstance = { ...current, name, pluginProfileId, enabled, variables };
    const definition = registry.get(profile.pluginId);
    const instanceError = definition?.validateInstance?.({ ...instance, pluginId: definition.id, config: profile.config });
    if (instanceError) return response.status(400).json({ error: instanceError });
    const identityError = validateSharedNativePageInstance(instance, definition, store.get().pluginInstances, store.get().pluginProfiles, registry);
    if (identityError) return response.status(400).json({ error: identityError });
    const assignedToHardwareButton = store.get().panels.some((panel) => Object.values(panel.hardwareButtonPluginInstances ?? {}).includes(instance.id));
    if (assignedToHardwareButton && (!instance.enabled || !definition?.capabilities.includes("favorite-toggle") || !definition.handleFavoritePress)) {
      return response.status(400).json({ error: "Remove this instance from the physical button assignments before disabling it or changing it to a plugin without toggle support." });
    }
    await store.update((config) => { config.pluginInstances = config.pluginInstances.map((item) => item.id === instance.id ? instance : item); });
    await runtime.refreshPluginInstances();
    if (definition?.nativePanelSharedInstances) publishSharedNativePageSettings(store, runtime);
    response.json({ instance });
  });

  router.delete("/instances/:id", async (request, response) => {
    const id = request.params.id;
    const config = store.get();
    const removedInstance = config.pluginInstances.find((item) => item.id === id);
    if (!removedInstance) return response.status(404).json({ error: "Plugin instance not found." });
    const removedProfile = config.pluginProfiles.find((item) => item.id === removedInstance.pluginProfileId);
    const removedDefinition = removedProfile && registry.get(removedProfile.pluginId);
    const removedBindings = config.panelBindings.filter((binding) => binding.pluginInstanceId === id);
    const panelsUsingInstance = new Set(config.panels.filter((panel) =>
      panel.settings.buttons.some((button) => button.pluginInstanceId === id) ||
      Object.values(panel.nativePluginInstances ?? {}).includes(id) ||
      Object.values(panel.panelEventPluginInstances ?? {}).includes(id) ||
      Object.values(panel.hardwareButtonPluginInstances ?? {}).includes(id)
    ).map((panel) => panel.id));
    for (const binding of removedBindings) {
      const panel = config.panels.find((item) => item.id === binding.panelId);
      if (panel) await runtime.closePanelBinding(panel, binding.id);
    }
    const updated = await store.update((current) => {
      current.panelBindings = current.panelBindings.filter((binding) => binding.pluginInstanceId !== id);
      for (const binding of removedBindings) clearFavoriteBinding(current.panels, binding);
      current.panels = current.panels.map((panel) => ({
        ...panel,
        settings: {
          ...panel.settings,
          buttons: panel.settings.buttons.map((button) => button.pluginInstanceId === id
            ? { ...button, pluginInstanceId: undefined }
            : button)
        },
        nativePluginInstances: Object.fromEntries(Object.entries(panel.nativePluginInstances ?? {}).filter(([, instanceId]) => instanceId !== id)),
        panelEventPluginInstances: Object.fromEntries(Object.entries(panel.panelEventPluginInstances ?? {}).filter(([, instanceId]) => instanceId !== id)),
        hardwareButtonPluginInstances: Object.fromEntries(Object.entries(panel.hardwareButtonPluginInstances ?? {}).filter(([, instanceId]) => instanceId !== id))
      }));
      current.pluginInstances = current.pluginInstances.filter((item) => item.id !== id);
    });
    await runtime.removePluginRuntimeState(id);
    for (const panel of updated.panels.filter((item) => panelsUsingInstance.has(item.id))) {
      runtime.publishPanelSettings(panel);
    }
    await runtime.refreshPluginInstances();
    if (removedDefinition?.nativePanelSharedInstances) publishSharedNativePageSettings(store, runtime);
    response.status(204).end();
  });

  router.post("/bindings", async (request, response) => {
    const config = store.get();
    const panelId = stringValue(request.body?.panelId);
    const pluginInstanceId = stringValue(request.body?.pluginInstanceId);
    const panel = config.panels.find((item) => item.id === panelId);
    const instance = config.pluginInstances.find((item) => item.id === pluginInstanceId);
    const profile = instance && config.pluginProfiles.find((item) => item.id === instance.pluginProfileId);
    const pluginRegistered = profile ? registry.get(profile.pluginId) : undefined;
    const name = stringValue(request.body?.name).trim();
    const index = Number(request.body?.favoriteIndex);
    if (!panel || !instance?.enabled || !pluginRegistered || !name || !Number.isInteger(index) || index < 0 || index > 11) {
      return response.status(400).json({ error: "Choose a panel, plugin instance, favorite slot, and shortcut name." });
    }
    if (pluginRegistered.nativePanelPage) {
      return response.status(400).json({ error: `This plugin uses the panel's native '${pluginRegistered.nativePanelPage}' page. Assign its instance in the panel settings.` });
    }
    if (!pluginRegistered.favoriteFlow) {
      return response.status(400).json({ error: "This plugin does not provide a page that can be opened from a favorite shortcut." });
    }
    if (config.panelBindings.some((binding) => binding.panelId === panelId && binding.trigger.type === "favorite" && binding.trigger.index === index)) {
      return response.status(409).json({ error: "That favorite slot is already bound." });
    }
    const binding: PanelBinding = {
      id: randomUUID(), name, panelId, pluginInstanceId,
      trigger: { type: "favorite", index }
    };
    const updated = await store.update((current) => {
      const target = current.panels.find((item) => item.id === panelId);
      if (!target) return;
      target.settings.favorites.buttons[index] = { ...target.settings.favorites.buttons[index], label: name, mode: 0 };
      current.panelBindings.push(binding);
    });
    const savedPanel = updated.panels.find((item) => item.id === panelId);
    if (savedPanel) runtime.publishPanelSettings(savedPanel);
    runtime.syncSubscriptions();
    response.status(201).json({ binding });
  });

  router.delete("/bindings/:id", async (request, response) => {
    const id = request.params.id;
    const binding = store.get().panelBindings.find((item) => item.id === id);
    if (!binding) return response.status(404).json({ error: "Panel binding not found." });
    const savedPanel = store.get().panels.find((item) => item.id === binding.panelId);
    if (savedPanel) await runtime.closePanelBinding(savedPanel, binding.id);
    const updated = await store.update((current) => {
      current.panelBindings = current.panelBindings.filter((item) => item.id !== id);
      clearFavoriteBinding(current.panels, binding);
    });
    const panel = updated.panels.find((item) => item.id === binding.panelId);
    if (panel) runtime.publishPanelSettings(panel);
    response.status(204).end();
  });

  return router;
}

/** Applies schema defaults and migrates older MQTT light brightness factors to ranges. */
function normalizePluginConfig(definition: PluginDefinition, input: unknown): Record<string, PluginConfigValue> {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const normalized = Object.fromEntries(pluginConfigSchema(definition).map((field) => {
    const value = source[field.key];
    return [field.key, isConfigValue(value) ? value : field.defaultValue];
  }));
  if (definition.id === "mqtt-light" && source["brightnessMinimum"] === undefined && source["brightnessMaximum"] === undefined) {
    const legacyFactor = source["brightnessFactor"];
    if (typeof legacyFactor === "number" && Number.isFinite(legacyFactor) && legacyFactor > 0) {
      normalized["brightnessMinimum"] = 0;
      normalized["brightnessMaximum"] = Math.round(100 / legacyFactor);
    }
  }
  return normalized;
}

function normalizePluginVariables(input: unknown): Record<string, string> {
  if (!isRecord(input)) return {};
  return Object.fromEntries(Object.entries(input).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

/** Ensures shared native-page instances cannot claim the same firmware slot or room name. */
function validateSharedNativePageInstance(
  instance: PluginInstance,
  definition: PluginDefinition | undefined,
  instances: PluginInstance[],
  profiles: PluginProfile[],
  registry: PluginRegistry
): string | undefined {
  if (!definition?.nativePanelSharedInstances) return undefined;
  const instanceName = instance.name.trim();
  const playerName = instance.variables.playerName?.trim();
  const playerId = Number(instance.variables.playerId);
  if (instance.enabled) {
    const activePeers = instances.filter((candidate) => candidate.enabled && candidate.id !== instance.id).filter((candidate) => {
      const profile = profiles.find((item) => item.id === candidate.pluginProfileId);
      return Boolean(profile && registry.get(profile.pluginId)?.id === definition.id);
    });
    if (activePeers.length >= 8) return "The panel music page supports up to eight configured players.";
  }
  for (const candidate of instances) {
    if (candidate.id === instance.id) continue;
    const profile = profiles.find((item) => item.id === candidate.pluginProfileId);
    if (!profile || registry.get(profile.pluginId)?.id !== definition.id) continue;
    if (instanceName && candidate.name.trim() === instanceName) {
      return `Instance name '${instanceName}' is already used by another ${definition.name} instance.`;
    }
    if (playerName && candidate.variables.playerName?.trim() === playerName) {
      return `Player name '${playerName}' is already used by another ${definition.name} instance.`;
    }
    if (Number.isInteger(playerId) && Number(candidate.variables.playerId) === playerId) {
      return `Music player ID ${playerId} is already used by another ${definition.name} instance.`;
    }
  }
  return undefined;
}

/** Refreshes firmware settings on every panel after shared page player slots change. */
function publishSharedNativePageSettings(store: ConfigStore, runtime: MqttRuntime): void {
  for (const panel of store.get().panels) runtime.publishPanelSettings(panel);
}

function validatePluginVariables(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  if (!isRecord(input)) return "Plugin variables must be an object of names and text values.";
  const entries = Object.entries(input);
  if (entries.length > 64) return "Configure no more than 64 variables per plugin instance.";
  for (const [name, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) return "Variable names must start with a letter or underscore and contain only letters, numbers, and underscores.";
    if (typeof value !== "string" || value.length > 4096) return `Variable '${name}' must be text under 4,096 characters.`;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clearFavoriteBinding(panels: ReturnType<ConfigStore["get"]>["panels"], binding: PanelBinding): void {
  const panel = panels.find((item) => item.id === binding.panelId);
  const favorite = panel?.settings.favorites.buttons[binding.trigger.index];
  if (favorite?.label === binding.name) favorite.label = "";
}

function isConfigValue(value: unknown): value is PluginConfigValue {
  return typeof value === "string" || typeof value === "number" && Number.isFinite(value) || typeof value === "boolean";
}
async function validateConfiguredScripts(config: Record<string, PluginConfigValue>, variables: Record<string, string>): Promise<string | undefined> {
  for (const key of ["startupCode", "buttonPressCode"]) {
    const source = config[key];
    if (typeof source !== "string" || !source.trim()) continue;
    const error = await checkScriptSyntax(source, variables);
    if (error) return error;
  }
  return undefined;
}
function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }

function hasConfiguredPage(config: Record<string, PluginConfigValue>, pageId: string): boolean {
  const value = config["pages"];
  if (typeof value !== "string") return false;
  try {
    const rows: unknown = JSON.parse(value);
    return Array.isArray(rows) && rows.some((row) => row && typeof row === "object" && !Array.isArray(row) && (row as Record<string, unknown>)["id"] === pageId);
  } catch {
    return false;
  }
}

/**
 * Creates a disposable script context for page and button previews. Writes are
 * made to local snapshots so a function can read its own changes within this
 * request; no storage value or MQTT command reaches the live runtime.
 */
function createPreviewContext(instance: ResolvedPluginInstance, debugLogs: string[], runtime: MqttRuntime): PluginRuntimeContext {
  const panel: Pick<Panel, "id" | "name" | "nodeName"> = { id: "preview-panel", name: "Preview panel", nodeName: "preview" };
  const binding: PanelBinding = {
    id: "preview-binding", name: "Page preview", panelId: panel.id,
    pluginInstanceId: instance.id, trigger: { type: "favorite", index: 0 }
  };
  const storage = structuredClone(runtime.getScriptStorageSnapshots(instance.id));
  const scopeValues = (scope: "global" | "plugin" | "panel"): Record<string, unknown> => {
    if (scope === "global") return storage.global;
    if (scope === "plugin") return storage.plugin;
    let previewPanel = storage.panels.find((item) => item.id === panel.id);
    if (!previewPanel) {
      previewPanel = { id: panel.id, name: panel.name, values: {} };
      storage.panels.push(previewPanel);
    }
    return previewPanel.values;
  };
  const namedPanelValues = (panelNameOrId: string): Record<string, unknown> => {
    let target = storage.panels.find((item) => item.id === panelNameOrId || item.name === panelNameOrId);
    if (!target) {
      target = { id: panelNameOrId, name: panelNameOrId, values: {} };
      storage.panels.push(target);
    }
    return target.values;
  };
  return {
    panel,
    binding,
    variables: instance.variables ?? {},
    storage: {
      get: async (scope, key) => structuredClone(scopeValues(scope)[key]),
      set: async (scope, key, value) => { scopeValues(scope)[key] = structuredClone(value); },
      delete: async (scope, key) => { delete scopeValues(scope)[key]; },
      snapshot: async (scope) => structuredClone(scopeValues(scope)),
      snapshotPanels: async () => structuredClone(storage.panels),
      setPanel: async (panelNameOrId, key, value) => { namedPanelValues(panelNameOrId)[key] = structuredClone(value); },
      deletePanel: async (panelNameOrId, key) => { delete namedPanelValues(panelNameOrId)[key]; }
    },
    publish: () => false,
    debug: {
      log: (message) => {
        debugLogs.push(message);
        runtime.logPluginDebug(instance.name, "preview", message);
      }
    }
  };
}

function isConcreteMqttTopic(topic: string): boolean { return Boolean(topic) && !/[+#\u0000]/.test(topic); }

function matchesTopicFilter(filter: string, topic: string): boolean {
  const filterLevels = filter.split("/");
  const topicLevels = topic.split("/");
  for (let index = 0; index < filterLevels.length; index++) {
    if (filterLevels[index] === "#") return true;
    if (index >= topicLevels.length || (filterLevels[index] !== "+" && filterLevels[index] !== topicLevels[index])) return false;
  }
  return filterLevels.length === topicLevels.length;
}
