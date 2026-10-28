import { Router, type RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import type { Panel, PanelBinding, PluginConfigValue, PluginInstance, PluginProfile, ResolvedPluginInstance } from "../../types.js";
import type { ConfigStore } from "../../services/config-store.js";
import type { MqttRuntime } from "../../services/mqtt-runtime.js";
import type { Logger } from "../../services/logger.js";
import {
  pluginConfigSchema,
  type MqttMessageEnvelope,
  type PluginApiRoute,
  type PluginApiRouteMethod,
  type PluginDefinition,
  type PluginRuntimeContext
} from "./plugin-contract.js";
import type { PluginRegistry } from "./plugin-registry.js";
import { checkScriptSyntax } from "./script-runtime.js";
import { preserveBlankPluginSecrets, presentPluginProfile } from "./plugin-profile-utils.js";

const PLUGIN_BLUEPRINT_FORMAT = "nspanel-manager-plugin-blueprint";
const PLUGIN_BLUEPRINT_SCHEMA_VERSION = 1;

interface ParsedPluginBlueprint {
  format: typeof PLUGIN_BLUEPRINT_FORMAT;
  schemaVersion: number;
  pluginId: string;
  pluginVersion: number;
  profile: {
    name: string;
    config: Record<string, unknown>;
  };
  instanceTemplate?: {
    name: string;
    variables: Record<string, unknown>;
  };
}

interface ValidatedPluginBlueprint {
  definition: PluginDefinition;
  profileName: string;
  config: Record<string, PluginConfigValue>;
  variables?: Record<string, string>;
  instanceName?: string;
  omittedSecrets: string[];
  missingSecrets: string[];
  warnings: string[];
}

/**
 * Exposes plugin discovery, reusable plugin profiles, device instances, and
 * favorite bindings. Plugin schemas drive the Angular editor; profiles hold
 * shared behavior while instances supply their own names and variable values.
 */
export function createPluginsRouter(store: ConfigStore, runtime: MqttRuntime, registry: PluginRegistry, logger: Logger): Router {
  const router = Router();
  registerPluginApiRoutes(router, store, registry, logger);

  router.get("/", (_request, response) => response.json({ plugins: registry.list() }));
  router.get("/profiles", (_request, response) => response.json({
    profiles: store.get().pluginProfiles.map((profile) => presentPluginProfile(profile, registry))
  }));
  router.get("/instances", (_request, response) => response.json({
    instances: store.get().pluginInstances,
    bindings: store.get().panelBindings
  }));

  router.get("/blueprints/:profileId", (request, response) => {
    const config = store.get();
    const profile = config.pluginProfiles.find((item) => item.id === request.params.profileId);
    if (!profile) return response.status(404).json({ error: "Plugin profile not found." });
    const definition = registry.get(profile.pluginId);
    if (!definition) return response.status(409).json({ error: "The profile uses a plugin that is not registered." });

    const instanceId = stringValue(request.query["instanceId"]);
    const instance = instanceId
      ? config.pluginInstances.find((item) => item.id === instanceId && item.pluginProfileId === profile.id)
      : undefined;
    if (instanceId && !instance) return response.status(404).json({ error: "Choose an instance that uses this plugin profile." });

    const secretKeys = new Set(pluginConfigSchema(definition)
      .filter((field) => field.secret || field.type === "password")
      .map((field) => field.key));
    const omittedSecrets = [...secretKeys].map((key) => `config.${key}`);
    const safeConfig = Object.fromEntries(Object.entries(profile.config).filter(([key]) => !secretKeys.has(key)));
    let instanceTemplate: ParsedPluginBlueprint["instanceTemplate"];
    if (instance) {
      const safeVariables = Object.fromEntries(Object.entries(instance.variables ?? {}).filter(([key]) => !isSensitiveVariableName(key)));
      omittedSecrets.push(...Object.keys(instance.variables ?? {})
        .filter(isSensitiveVariableName)
        .map((key) => `variables.${key}`));
      instanceTemplate = { name: instance.name, variables: safeVariables };
    }

    const blueprint = {
      format: PLUGIN_BLUEPRINT_FORMAT,
      schemaVersion: PLUGIN_BLUEPRINT_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      pluginId: registry.canonicalId(profile.pluginId),
      pluginVersion: definition.version,
      profile: { name: profile.name, config: safeConfig },
      ...(instanceTemplate ? { instanceTemplate } : {}),
      omittedSecrets
    };
    const filename = `${safeDownloadName(profile.name)}.nspanel-plugin.json`;
    response.type("application/json");
    response.attachment(filename);
    response.send(`${JSON.stringify(blueprint, null, 2)}\n`);
  });

  router.post("/blueprints/preview", async (request, response) => {
    const validated = await validatePluginBlueprint(request.body?.blueprint, registry);
    if ("error" in validated) return response.status(400).json({ error: validated.error });
    const config = store.get();
    const profileNameConflict = config.pluginProfiles.some((item) =>
      item.name.trim().toLocaleLowerCase() === validated.profileName.trim().toLocaleLowerCase());
    const instanceNameConflict = Boolean(validated.instanceName && config.pluginInstances.some((item) => {
      const profile = config.pluginProfiles.find((candidate) => candidate.id === item.pluginProfileId);
      return profile?.pluginId === validated.definition.id &&
        item.name.trim().toLocaleLowerCase() === validated.instanceName?.trim().toLocaleLowerCase();
    }));
    response.json({
      pluginId: validated.definition.id,
      pluginName: validated.definition.name,
      pluginVersion: validated.definition.version,
      profileName: validated.profileName,
      profileNameConflict,
      instanceName: validated.instanceName ?? "",
      instanceNameConflict,
      hasInstanceTemplate: Boolean(validated.variables),
      omittedSecrets: validated.omittedSecrets,
      missingSecrets: validated.missingSecrets,
      warnings: validated.warnings
    });
  });

  router.post("/blueprints/import", async (request, response) => {
    const validated = await validatePluginBlueprint(request.body?.blueprint, registry);
    if ("error" in validated) return response.status(400).json({ error: validated.error });
    const profileName = stringValue(request.body?.profileName).trim() || validated.profileName;
    const includeInstance = request.body?.includeInstance === true;
    const instanceName = stringValue(request.body?.instanceName).trim() || validated.instanceName || "";
    const current = store.get();
    if (current.pluginProfiles.some((item) => item.name.trim().toLocaleLowerCase() === profileName.toLocaleLowerCase())) {
      return response.status(409).json({ error: `A plugin profile named '${profileName}' already exists. Choose another name.` });
    }
    if (includeInstance && !validated.variables) {
      return response.status(400).json({ error: "This blueprint does not contain an instance template." });
    }
    if (includeInstance && !instanceName) return response.status(400).json({ error: "Enter a name for the imported instance." });
    if (includeInstance && current.pluginInstances.some((item) => {
      const profile = current.pluginProfiles.find((candidate) => candidate.id === item.pluginProfileId);
      return profile?.pluginId === validated.definition.id && item.name.trim().toLocaleLowerCase() === instanceName.toLocaleLowerCase();
    })) {
      return response.status(409).json({ error: `An instance named '${instanceName}' already exists for this plugin. Choose another name.` });
    }

    const profile: PluginProfile = {
      id: randomUUID(),
      name: profileName,
      pluginId: validated.definition.id,
      config: validated.config
    };
    let instance: PluginInstance | undefined;
    if (includeInstance && validated.variables) {
      const missingVariables = (validated.definition.instanceVariableFields ?? [])
        .filter((field) => field.required && !validated.variables?.[field.key]?.trim());
      if (missingVariables.length > 0) {
        return response.status(400).json({
          error: `Complete the required instance values before importing: ${missingVariables.map((field) => field.label).join(", ")}.`
        });
      }
      const variableError = validatePluginVariables(validated.variables);
      if (variableError) return response.status(400).json({ error: variableError });
      instance = {
        id: randomUUID(),
        name: instanceName,
        pluginProfileId: profile.id,
        enabled: true,
        variables: validated.variables
      };
      const resolved = { ...instance, pluginId: validated.definition.id, config: profile.config };
      const instanceError = validated.definition.validateInstance?.(resolved);
      if (instanceError) return response.status(400).json({ error: instanceError });
      const identityError = validateSharedNativePageInstance(
        instance,
        validated.definition,
        current.pluginInstances,
        [...current.pluginProfiles, profile],
        registry
      );
      if (identityError) return response.status(400).json({ error: identityError });
    }

    await store.update((next) => {
      next.pluginProfiles.push(profile);
      if (instance) next.pluginInstances.push(instance);
    }, {
      actor: request.authUser?.email ?? "unknown",
      summary: `Plugin blueprint '${profile.name}' imported`
    });
    await runtime.refreshPluginInstances();
    response.status(201).json({
      profile: presentPluginProfile(profile, registry),
      ...(instance ? { instance } : {}),
      warnings: validated.warnings
    });
  });

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
    await store.update((current) => { current.pluginProfiles.push(profile); }, {
      actor: request.authUser?.email ?? "unknown",
      summary: `Plugin '${profile.name}' created`
    });
    await runtime.refreshPluginInstances();
    response.status(201).json({ profile: presentPluginProfile(profile, registry) });
  });

  router.put("/profiles/:id", async (request, response) => {
    const current = store.get().pluginProfiles.find((item) => item.id === request.params.id);
    if (!current) return response.status(404).json({ error: "Plugin not found." });
    const previousDefinition = registry.get(current.pluginId);
    const name = stringValue(request.body?.name).trim();
    const definition = registry.get(stringValue(request.body?.pluginId));
    if (!name || !definition) return response.status(400).json({ error: "A name and registered plugin type are required." });
    const normalizedConfig = normalizePluginConfig(definition, request.body?.config);
    const config = preserveBlankPluginSecrets(definition, current.config, normalizedConfig);
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
    }, {
      actor: request.authUser?.email ?? "unknown",
      summary: `Plugin '${profile.name}' updated`
    });
    await runtime.refreshPluginInstances();
    if (previousDefinition?.nativePanelSharedInstances || definition.nativePanelSharedInstances) publishSharedNativePageSettings(store, runtime);
    response.json({ profile: presentPluginProfile(profile, registry) });
  });

  router.delete("/profiles/:id", async (request, response) => {
    const profileId = request.params.id;
    if (!store.get().pluginProfiles.some((item) => item.id === profileId)) return response.status(404).json({ error: "Plugin not found." });
    if (store.get().pluginInstances.some((item) => item.pluginProfileId === profileId)) {
      return response.status(409).json({ error: "Remove or reassign this plugin's instances before deleting it." });
    }
    await store.update((config) => { config.pluginProfiles = config.pluginProfiles.filter((item) => item.id !== profileId); }, {
      actor: request.authUser?.email ?? "unknown",
      summary: `Plugin '${store.get().pluginProfiles.find((item) => item.id === profileId)?.name ?? profileId}' deleted`
    });
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
    await store.update((current) => { current.pluginInstances.push(instance); }, {
      actor: request.authUser?.email ?? "unknown",
      summary: `Plugin instance '${instance.name}' created`
    });
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
    await store.update((config) => { config.pluginInstances = config.pluginInstances.map((item) => item.id === instance.id ? instance : item); }, {
      actor: request.authUser?.email ?? "unknown",
      summary: `Plugin instance '${instance.name}' updated`
    });
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
    }, {
      actor: request.authUser?.email ?? "unknown",
      summary: `Plugin instance '${removedInstance.name}' deleted`
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
    }, {
      actor: request.authUser?.email ?? "unknown",
      summary: `Favorite '${name}' assigned on panel '${panel.name}'`
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
    }, {
      actor: request.authUser?.email ?? "unknown",
      summary: `Favorite '${binding.name}' unassigned`
    });
    const panel = updated.panels.find((item) => item.id === binding.panelId);
    if (panel) runtime.publishPanelSettings(panel);
    response.status(204).end();
  });

  return router;
}

/** Mounts each plugin's declared API routes below its manager-owned namespace. */
function registerPluginApiRoutes(router: Router, store: ConfigStore, registry: PluginRegistry, logger: Logger): void {
  for (const pluginMetadata of registry.list()) {
    const definition = registry.get(pluginMetadata.id);
    if (!definition?.registerRoutes) continue;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(definition.id)) {
      throw new Error(`Plugin '${definition.id}' has an invalid identifier for API routes.`);
    }

    for (const route of definition.registerRoutes()) {
      const path = normalizePluginApiRoutePath(route.url, definition.id);
      if (!isPluginApiRouteMethod(route.method)) {
        throw new Error(`Plugin '${definition.id}' declared unsupported API method '${String(route.method)}'.`);
      }

      const fullPath = `/profiles/:id/plugin/${definition.id}/${path}`;
      const handler: RequestHandler = (request, response, next) => {
        const profile = store.get().pluginProfiles.find((item) => item.id === request.params["id"]);
        if (!profile || profile.pluginId !== definition.id) {
          response.status(404).json({ error: `${definition.name} profile not found.` });
          return;
        }

        void Promise.resolve()
          .then(() => route.callback({ request, response, profile, logger }))
          .catch(next);
      };

      switch (route.method) {
        case "get":
          router.get(fullPath, handler);
          break;
        case "post":
          router.post(fullPath, handler);
          break;
        case "put":
          router.put(fullPath, handler);
          break;
        case "patch":
          router.patch(fullPath, handler);
          break;
        case "delete":
          router.delete(fullPath, handler);
          break;
      }
    }
  }
}

/** Ensures a plugin can declare only relative, plugin-owned route path segments. */
function normalizePluginApiRoutePath(path: string, pluginId: string): string {
  const segments = path.split("/");
  const validSegment = (segment: string): boolean =>
    /^[a-zA-Z0-9_-]+$/.test(segment) || /^:[a-zA-Z][a-zA-Z0-9_]*$/.test(segment);
  if (!path || path.startsWith("/") || path.endsWith("/") || !segments.every(validSegment)) {
    throw new Error(`Plugin '${pluginId}' declared an invalid relative API route path '${path}'.`);
  }
  return segments.join("/");
}

/** Checks the HTTP methods supported by the plugin route contract. */
function isPluginApiRouteMethod(method: string): method is PluginApiRouteMethod {
  return ["get", "post", "put", "patch", "delete"].includes(method);
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

/** Validates an untrusted blueprint against the currently registered plugin schema. */
async function validatePluginBlueprint(input: unknown, registry: PluginRegistry): Promise<ValidatedPluginBlueprint | { error: string }> {
  if (!isRecord(input)) return { error: "The selected file must contain a plugin blueprint object." };
  if (input["format"] !== PLUGIN_BLUEPRINT_FORMAT) return { error: "This file is not an NSPanel Manager plugin blueprint." };
  if (input["schemaVersion"] !== PLUGIN_BLUEPRINT_SCHEMA_VERSION) {
    return { error: `Blueprint schema version '${String(input["schemaVersion"])}' is not supported.` };
  }
  const pluginId = stringValue(input["pluginId"]);
  const definition = registry.get(pluginId);
  if (!definition) return { error: `Plugin '${pluginId || "(missing ID)"}' is not installed in this manager.` };
  if (!Number.isInteger(input["pluginVersion"])) return { error: "The blueprint is missing its plugin version." };
  if (!isRecord(input["profile"])) return { error: "The blueprint is missing its plugin profile." };

  const profileName = stringValue(input["profile"]["name"]).trim();
  if (!profileName) return { error: "The blueprint profile needs a name." };
  const sourceConfig = input["profile"]["config"];
  if (!isRecord(sourceConfig)) return { error: "The blueprint profile configuration must be an object." };
  const fields = pluginConfigSchema(definition);
  const fieldsByKey = new Map(fields.map((field) => [field.key, field]));
  const unknownKeys = Object.keys(sourceConfig).filter((key) => !fieldsByKey.has(key));
  if (unknownKeys.length > 0) return { error: `Unsupported configuration field${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.join(", ")}.` };

  const config: Record<string, PluginConfigValue> = {};
  const missingSecrets: string[] = [];
  for (const field of fields) {
    const sensitive = field.secret === true || field.type === "password";
    if (sensitive) {
      config[field.key] = typeof field.defaultValue === "string" ? "" : field.defaultValue;
      if (field.required) missingSecrets.push(field.label);
      continue;
    }
    const value = Object.hasOwn(sourceConfig, field.key) ? sourceConfig[field.key] : field.defaultValue;
    if (!matchesPluginConfigType(field, value)) {
      return { error: `Configuration field '${field.label}' has the wrong value type.` };
    }
    if (field.required && (typeof value === "string" ? !value.trim() : value === undefined)) {
      return { error: `Required configuration field '${field.label}' is empty.` };
    }
    config[field.key] = value;
  }

  let variables: Record<string, string> | undefined;
  let instanceName: string | undefined;
  if (input["instanceTemplate"] !== undefined) {
    if (!isRecord(input["instanceTemplate"])) return { error: "The instance template must be an object." };
    instanceName = stringValue(input["instanceTemplate"]["name"]).trim();
    if (!instanceName) return { error: "The instance template needs a name." };
    const sourceVariables = input["instanceTemplate"]["variables"];
    const variableError = validatePluginVariables(sourceVariables);
    if (variableError) return { error: variableError };
    if (!isRecord(sourceVariables)) return { error: "Instance template variables must be an object." };
    variables = Object.fromEntries(Object.entries(sourceVariables)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    for (const key of Object.keys(variables)) {
      if (isSensitiveVariableName(key)) return { error: `Sensitive instance variable '${key}' cannot be imported from a blueprint.` };
    }
  }

  const validationConfig = { ...config };
  for (const field of fields.filter((candidate) => candidate.secret || candidate.type === "password")) {
    validationConfig[field.key] = `blueprint-secret-placeholder:${field.key}`;
  }
  const configError = definition.validateConfig(validationConfig);
  if (configError) return { error: configError };
  const scriptError = await validateConfiguredScripts(config, variables ?? {});
  if (scriptError) return { error: scriptError };

  const warnings: string[] = [];
  if (input["pluginVersion"] !== definition.version) {
    warnings.push(`Blueprint was exported from plugin version ${String(input["pluginVersion"])}; this manager has version ${definition.version}.`);
  }
  for (const field of definition.instanceVariableFields ?? []) {
    if (field.required && !variables?.[field.key]?.trim()) warnings.push(`Instance template needs a value for '${field.label}'.`);
  }
  if (missingSecrets.length > 0) warnings.push(`Enter these secret settings after import: ${missingSecrets.join(", ")}.`);

  const omittedSecrets = fields
    .filter((field) => field.secret || field.type === "password")
    .map((field) => `config.${field.key}`);
  if (Array.isArray(input["omittedSecrets"])) {
    for (const item of input["omittedSecrets"].slice(0, 128)) {
      if (typeof item === "string" && item.startsWith("variables.")) {
        const variableName = item.slice("variables.".length);
        if (/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(variableName) && isSensitiveVariableName(variableName)) {
          omittedSecrets.push(item);
        }
      }
    }
  }
  return {
    definition,
    profileName,
    config,
    ...(variables ? { variables } : {}),
    ...(instanceName ? { instanceName } : {}),
    omittedSecrets: [...new Set(omittedSecrets)],
    missingSecrets,
    warnings
  };
}

/** Checks whether a blueprint value matches the editor type for one plugin setting. */
function matchesPluginConfigType(field: ReturnType<typeof pluginConfigSchema>[number], value: unknown): value is PluginConfigValue {
  if (field.type === "number") return typeof value === "number" && Number.isFinite(value);
  if (field.type === "checkbox") return typeof value === "boolean";
  return typeof value === "string";
}

/** Omits credential-like custom variable names from portable instance templates. */
function isSensitiveVariableName(name: string): boolean {
  const normalized = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").toLowerCase();
  return /(?:^|_)(?:password|passwd|secret|token|credential|credentials|authentication|auth|api_key|access_key)(?:_|$)/.test(normalized);
}

/** Creates a safe portable filename from a profile name. */
function safeDownloadName(name: string): string {
  const filename = name.normalize("NFKD").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return filename || "plugin";
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
