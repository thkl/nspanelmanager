import mqtt, { type MqttClient } from "mqtt";
import { randomUUID } from "node:crypto";
import type { ConfigStore } from "./config-store.js";
import type { ManagerConfig, MqttRoute, Panel, PanelBinding, PanelConnectionStatus, ResolvedPluginInstance } from "../types.js";
import { PanelProtocolAdapter, type PanelInputEvent } from "../features/panels/panel-protocol-adapter.js";
import type { PanelFlowSession, RuntimeStateStore } from "../features/runtime/runtime-state-store.js";
import type { MqttMessageEnvelope, PanelStorageSnapshot, PluginDefinition, PluginMqttSubscription, PluginNativePanelInstanceState, PluginPageNavigation, PluginRuntimeContext, PluginState, PluginStorageScope } from "../features/plugins/plugin-contract.js";
import type { PluginRegistry } from "../features/plugins/plugin-registry.js";
import { interpolatePluginTemplate } from "../features/plugins/plugin-variables.js";
import { Logger } from "./logger.js";

/**
 * Maintains the shared MQTT connection and dispatches device and panel events.
 * The runtime coordinates registered plugins, panel protocol adaptation,
 * durable flow sessions, configurable MQTT routes, and an in-memory panel
 * connection view sourced from each panel's LWT status and minute heartbeat.
 */
export class MqttRuntime {
  private static readonly PANEL_HEARTBEAT_TIMEOUT_MS = 150_000;
  private client?: MqttClient;
  private connected = false;
  private lastError = "";
  private activeTopics = new Set<string>();
  private readonly pluginSubscriptions = new Map<string, PluginMqttSubscription[]>();
  private readonly initializedPluginConfigs = new Map<string, string>();
  private readonly pluginPollTimers = new Map<string, NodeJS.Timeout>();
  private readonly pollingPlugins = new Set<string>();
  private readonly pendingMessages = new Set<Promise<void>>();
  private readonly nativePanelPages = new Map<string, string>();
  private readonly panelHomeTilePages = new Map<string, { page: "home" | "light" | "level"; index?: number }>();
  private readonly publishedPanelSettings = new Map<string, string>();
  private readonly publishedPanelFavoriteStates = new Map<string, string>();
  private readonly panelConnections = new Map<string, { status: "online" | "offline"; lastSeenAt: number | null }>();
  private closing = false;
  private readonly panelProtocol: PanelProtocolAdapter;

  /** Creates the runtime around saved config, registered plugins, and runtime storage. */
  constructor(
    private readonly store: ConfigStore,
    private readonly plugins: PluginRegistry,
    private readonly runtimeState: RuntimeStateStore,
    private readonly logger: Logger = new Logger()
  ) {
    this.panelProtocol = new PanelProtocolAdapter((topic, payload) => this.publish(topic, payload));
  }

  /** Exposes health only; credentials and the client object never leave this service. */
  status(): { connected: boolean; error: string } { return { connected: this.connected, error: this.lastError }; }

  /** Publishes a manager-hosted HMI download URL to the selected panel's update topic. */
  publishHmiUpdate(panel: Panel, url: string): boolean {
    return this.publish(`${panel.nodeName}/cmnd/updatehmi`, JSON.stringify({ url }));
  }

  /** Returns live panel connection state without adding runtime data to saved configuration. */
  panelConnectionStatuses(): PanelConnectionStatus[] {
    const now = Date.now();
    return this.store.get().panels.map((panel) => {
      const connection = this.panelConnections.get(panel.nodeName);
      const heartbeatFresh = connection?.lastSeenAt !== null && connection?.lastSeenAt !== undefined
        && now - connection.lastSeenAt <= MqttRuntime.PANEL_HEARTBEAT_TIMEOUT_MS;
      return {
        panelId: panel.id,
        nodeName: panel.nodeName,
        status: connection?.status === "online" && heartbeatFresh ? "online" : "offline",
        lastSeenAt: connection?.lastSeenAt ?? null
      };
    });
  }

  /**
   * Replaces the current broker client using the latest saved credentials.
   * MQTT.js handles transient reconnect attempts after the client is created;
   * an empty URL leaves the manager disconnected during first-run setup.
   */
  async reconnect(): Promise<void> {
    this.closing = false;
    this.lastError = "";
    await this.refreshPluginInstances();
    if (this.client) {
      const oldClient = this.client;
      this.client = undefined;
      this.connected = false;
      this.activeTopics.clear();
      await new Promise<void>((resolve) => oldClient.end(true, {}, () => resolve()));
      await Promise.all([...this.pendingMessages]);
    }
    const broker = this.store.get().broker;
    if (!broker.url) return;

    try {
      const client = mqtt.connect(broker.url, {
        username: broker.username || undefined,
        password: broker.password || undefined,
        clientId: `nspanel-manager-${Math.random().toString(16).slice(2, 10)}`,
        reconnectPeriod: 3000,
        connectTimeout: 10000
      });
      this.client = client;
      client.handleMessage = (packet, callback) => this.dispatchMqttPacket(packet, callback);
      client.on("connect", () => {
        this.connected = true;
        this.lastError = "";
        this.syncSubscriptions();
        void this.notifyPluginsConnected();
        void this.restoreAllPanels().catch((error: unknown) => {
          this.lastError = error instanceof Error ? error.message : String(error);
        });
      });
      client.on("reconnect", () => { this.connected = false; });
      client.on("offline", () => { this.connected = false; });
      client.on("error", (error) => { this.lastError = error.message; });
    } catch (error) {
      this.connected = false;
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  /** Stops MQTT ingress and waits for message handlers already in progress. */
  async close(): Promise<void> {
    this.closing = true;
    const client = this.client;
    this.client = undefined;
    this.connected = false;
    this.activeTopics.clear();
    for (const id of this.pluginPollTimers.keys()) this.clearPluginPoll(id);
    if (client) await new Promise<void>((resolve) => client.end(true, {}, () => resolve()));
    await Promise.all(this.pendingMessages);
  }

  /** Processes one broker packet before MQTT.js advances to the next inbound packet. */
  private dispatchMqttPacket(
    packet: Parameters<MqttClient["handleMessage"]>[0],
    callback: Parameters<MqttClient["handleMessage"]>[1]
  ): void {
    if (this.closing) {
      callback();
      return;
    }

    const envelope: MqttMessageEnvelope = {
      topic: packet.topic,
      payload: packet.payload.toString(),
      qos: packet.qos,
      retain: packet.retain ?? false,
      receivedAt: Date.now()
    };
    const processing = (async () => {
      try {
        await this.handleMessage(envelope);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.lastError = detail;
        this.logger.error("MQTT message processing failed.", {
          component: "mqtt",
          phase: "dispatch",
          topic: envelope.topic,
          detail
        });
      } finally {
        callback();
      }
    })();

    this.pendingMessages.add(processing);
    void processing.then(
      () => this.pendingMessages.delete(processing),
      () => this.pendingMessages.delete(processing)
    );
  }

  /** Initializes enabled plugin instances and refreshes their registered MQTT callbacks. */
  async refreshPluginInstances(): Promise<void> {
    const instances = this.resolvePluginInstances();
    const enabledIds = new Set(instances.filter((instance) => instance.enabled).map((instance) => instance.id));
    for (const id of this.initializedPluginConfigs.keys()) {
      if (!enabledIds.has(id)) {
        this.initializedPluginConfigs.delete(id);
        this.pluginSubscriptions.delete(id);
        this.clearPluginPoll(id);
      }
    }

    for (const instance of instances) {
      if (!instance.enabled) continue;
      const definition = this.plugins.get(instance.pluginId);
      if (!definition) continue;
      const fingerprint = JSON.stringify([definition.id, definition.version, instance.config, instance.variables]);
      if (this.initializedPluginConfigs.get(instance.id) === fingerprint) continue;
      this.clearPluginPoll(instance.id);
      this.initializedPluginConfigs.set(instance.id, fingerprint);
      this.pluginSubscriptions.delete(instance.id);
      if (definition.initialize) {
        try {
          const subscriptions = await definition.initialize(
            instance,
            this.runtimeState.getPluginState(instance.id),
            this.createPluginLifecycleContext(instance, "startup")
          );
          this.pluginSubscriptions.set(instance.id, subscriptions.filter((subscription) => isValidTopicFilter(subscription.topicFilter)));
        } catch (error) {
          this.pluginSubscriptions.set(instance.id, []);
          const detail = error instanceof Error ? error.message : String(error);
          this.lastError = detail;
          this.logger.error("Plugin startup function failed.", {
            component: "plugin",
            instance: instance.name,
            phase: "startup",
            detail
          });
        }
      }
      this.startPluginPoll(instance, definition);
    }
    this.syncSubscriptions();
  }

  /** Subscribes to distinct panel events, plugin state filters, and route sources. */
  syncSubscriptions(): void {
    if (!this.client?.connected) return;
    const config = this.store.get();
    const instances = this.resolvePluginInstances(config);
    const desiredTopics = new Set<string>();
    const panelNodeNames = new Set(config.panels.map((panel) => panel.nodeName));
    for (const nodeName of this.panelConnections.keys()) {
      if (!panelNodeNames.has(nodeName)) this.panelConnections.delete(nodeName);
    }
    for (const panel of config.panels) {
      desiredTopics.add(`${panel.nodeName}/status`);
      desiredTopics.add(`${panel.nodeName}/event/#`);
    }
    for (const route of config.routes) desiredTopics.add(route.sourceTopic);
    for (const instance of instances) {
      if (!instance.enabled) continue;
      const definition = this.plugins.get(instance.pluginId);
      for (const topic of definition?.subscriptions(instance) ?? []) if (topic) desiredTopics.add(topic);
      for (const subscription of this.pluginSubscriptions.get(instance.id) ?? []) desiredTopics.add(subscription.topicFilter);
    }
    const additions = [...desiredTopics].filter((topic) => !this.activeTopics.has(topic));
    const removals = [...this.activeTopics].filter((topic) => !desiredTopics.has(topic));
    if (additions.length) {
      const client = this.client;
      try {
        client.subscribe(additions, (error, granted) => {
          if (client !== this.client) return;
          if (error) {
            for (const topic of additions) this.activeTopics.delete(topic);
            this.lastError = error.message;
            this.logger.error("MQTT subscribe request failed.", {
              component: "mqtt",
              topics: additions.join(", "),
              detail: error.message
            });
            return;
          }
          for (const grant of granted ?? []) {
            if (grant.qos === 128) {
              this.activeTopics.delete(grant.topic);
              const detail = `Broker refused subscription to '${grant.topic}'.`;
              this.lastError = detail;
              this.logger.error(detail, { component: "mqtt", topic: grant.topic });
            } else {
              this.logger.info("MQTT subscription acknowledged.", { component: "mqtt", topic: grant.topic });
            }
          }
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        for (const topic of additions) this.activeTopics.delete(topic);
        this.lastError = detail;
        this.logger.error("MQTT subscribe request failed.", {
          component: "mqtt",
          topics: additions.join(", "),
          detail
        });
      }
    }
    if (removals.length) this.client.unsubscribe(removals);
    this.activeTopics = desiredTopics;
  }

  /** Publishes changed settings, or always publishes when boot/apply explicitly requests a refresh. */
  publishPanelSettings(panel: Panel, force = false): boolean {
    const defaultPlayer = panel.nativePluginInstances ? panel.nativePluginInstances['music'] : undefined;
    const configuredPlayers = this.configuredNativePagePlayers("music",defaultPlayer);

    const settings = {
      ...panel.settings,
      music: configuredPlayers,
      buttons: panel.settings.buttons.map(({ label, image, mode }) => ({ label, image, mode }))
    };
    const configFingerprint = JSON.stringify({
      nodeName: panel.nodeName,
      settings: {
        ...settings,
        music: configuredPlayers.map(({ id, name, sonos, player }) => ({ id, name, sonos, player }))
      }
    });
    if (!force && this.publishedPanelSettings.get(panel.id) === configFingerprint) return true;
    const published = this.publish(`${panel.nodeName}/cmnd/settings`, JSON.stringify(settings));
    if (published) this.publishedPanelSettings.set(panel.id, configFingerprint);
    return published;
  }

  /** Builds the firmware's player-slot configuration from active shared music-page instances. */
  private configuredNativePagePlayers(pageId: string, defaultPlayer?:string): Array<{ id: string; name: string; sonos: string; player: string; currentSong?: string }> {
    return this.resolvePluginInstances()
      .filter((instance) => instance.enabled && this.plugins.get(instance.pluginId)?.nativePanelPage === pageId && this.plugins.get(instance.pluginId)?.nativePanelSharedInstances)
      .flatMap((instance) => {
        const topicPlayerName = instance.variables.playerName?.trim();
        const sonosName = instance.variables.sonosName?.trim() || topicPlayerName;
        const id = Number(instance.variables.playerId);
        if (!topicPlayerName || !sonosName || !instance.name.trim() || !Number.isInteger(id) || id < 0 || id > 10) return [];
        const state = this.runtimeState.getPluginState(instance.id);
        const currentSong = currentSonosSong(state);
        return [{
          id: String(id),
          current: instance.id === defaultPlayer,
          name: firmwareSafeText(instance.name),
          sonos: firmwareSafeText(sonosName),
          player: `sonos/${topicPlayerName}`,
          ...(currentSong ? { currentSong } : {})
        }];
      })
      .sort((left, right) => Number(left.id) - Number(right.id))
      .slice(0, 8);
  }

  /** Publishes the firmware's 12 favorite indicator bits from directly bound devices. */
  private async publishPanelFavoriteState(panel: Panel, bindings: PanelBinding[], instances: ResolvedPluginInstance[]): Promise<boolean> {
    let mask = 0;
    for (const binding of bindings) {
      const index = binding.trigger.index;
      if (binding.panelId !== panel.id || !Number.isInteger(index) || index < 0 || index > 11) continue;
      const instance = instances.find((candidate) => candidate.id === binding.pluginInstanceId && candidate.enabled);
      const definition = instance && this.plugins.get(instance.pluginId);
      if (!instance || !definition?.favoriteStateActive) continue;
      try {
        const active = await definition.favoriteStateActive(
          instance,
          this.runtimeState.getPluginState(instance.id),
          this.createPluginContext(panel, binding, instance)
        );
        if (active === true) mask |= 1 << index;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.logger.error("Favorite active state evaluation failed.", {
          component: "plugin", instance: instance.name, panel: panel.name, phase: "favorite state", detail
        });
      }
    }
    const payload = String(mask);
    if (this.publishedPanelFavoriteStates.get(panel.id) === payload) return true;
    const published = this.publish(`${panel.nodeName}/cmnd/favstate`, payload);
    if (published) this.publishedPanelFavoriteStates.set(panel.id, payload);
    return published;
  }

  /** Publishes only the Favorites configuration used by the firmware's Favorites page. */
  private publishPanelFavorites(panel: Panel): boolean {
    return this.publish(
      `${panel.nodeName}/cmnd/settings/favorites`,
      JSON.stringify({ favorites: panel.settings.favorites })
    );
  }

  /** Drops active flow and cached scoped values for a deleted plugin instance. */
  async removePluginRuntimeState(instanceId: string): Promise<void> { await this.runtimeState.removePluginInstance(instanceId); }

  /** Stores normalized device state in memory and refreshes favorite indicators that use it. */
  private async setPluginState(instance: ResolvedPluginInstance, state: PluginState): Promise<void> {
    await this.runtimeState.setPluginState(instance.id, state);
    const definition = this.plugins.get(instance.pluginId);
    for (const [key, value] of Object.entries(definition?.scriptStorageValues?.(instance, state) ?? {})) {
      if (value === undefined) continue;
      try {
        const currentValue = this.runtimeState.getValue("plugin", instance.id, key);
        if (JSON.stringify(currentValue) !== JSON.stringify(value)) {
          await this.runtimeState.setValue("plugin", instance.id, key, value);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.logger.error("Plugin state could not be mirrored to script storage.", {
          component: "plugin", instance: instance.name, phase: "state storage", key, detail
        });
      }
    }
    const config = this.store.get();
    if (!config.panelBindings.some((binding) => binding.pluginInstanceId === instance.id)) return;
    const instances = this.resolvePluginInstances(config);
    for (const panel of config.panels) {
      if (config.panelBindings.some((binding) => binding.panelId === panel.id && binding.pluginInstanceId === instance.id)) {
        await this.publishPanelFavoriteState(panel, config.panelBindings, instances);
      }
    }
  }

  /** Routes preview diagnostics through the shared logger while keeping them in the preview result. */
  logPluginDebug(pluginName: string, phase: string, message: string): void {
    this.logger.debug(message, { component: "plugin", instance: pluginName, phase });
  }

  /** Returns the durable values visible to an invocation of one plugin script. */
  getScriptStorageSnapshots(instanceId: string): {
    global: Record<string, unknown>;
    plugin: Record<string, unknown>;
    panels: PanelStorageSnapshot[];
  } {
    return {
      global: this.runtimeState.getScopeValues("global", ""),
      plugin: this.runtimeState.getScopeValues("plugin", instanceId),
      panels: this.getPanelStorageSnapshots()
    };
  }

  /** Drops active flow context and panel-scoped values for a deleted panel. */
  async removePanelRuntimeState(panelId: string): Promise<void> {
    this.nativePanelPages.delete(panelId);
    this.panelHomeTilePages.delete(panelId);
    this.publishedPanelSettings.delete(panelId);
    this.publishedPanelFavoriteStates.delete(panelId);
    await this.runtimeState.removePanel(panelId);
  }

  /** Reapplies assigned plugin state after panel settings are saved, including home-screen telemetry. */
  async refreshNativePanel(panel: Panel): Promise<void> {
    const instances = this.resolvePluginInstances();
    for (const [pageId, instanceId] of Object.entries(panel.nativePluginInstances ?? {})) {
      const instance = instances.find((candidate) => candidate.id === instanceId && candidate.enabled);
      const definition = instance && this.plugins.get(instance.pluginId);
      if (!instance || !definition || definition.nativePanelPage !== pageId) continue;
      const state = this.runtimeState.getPluginState(instance.id);
      await this.publishAssignedPanelState(definition, instance, panel, {}, state, state);
      if (this.nativePanelPages.get(panel.id) === pageId) await this.publishNativePanelState(definition, instance, panel, state);
    }
    if (this.panelHomeTilePages.get(panel.id)?.page === "home") await this.refreshAllHomeTiles(panel);
  }

  /** Closes a currently visible flow screen before its favorite binding is removed. */
  async closePanelBinding(panel: Panel, bindingId: string): Promise<void> {
    const session = this.runtimeState.getPanelSession(panel.id);
    if (!session || session.bindingId !== bindingId && !session.ancestors?.some((ancestor) => ancestor.bindingId === bindingId)) return;
    await this.runtimeState.setPanelSession(panel.id);
    this.panelProtocol.exitToHome(panel);
  }

  /**
   * Handles one inbound MQTT packet, first offering it to matching plugins and
   * panel protocol handlers, then preserving configured route forwarding.
   */
  private async handleMessage(message: MqttMessageEnvelope): Promise<void> {
    const config = this.store.get();
    const { topic, payload } = message;
    this.updatePanelConnection(topic, payload, message.receivedAt, config.panels);
    const instances = this.resolvePluginInstances(config);
    const eventPanel = config.panels.find((panel) => topic.startsWith(`${panel.nodeName}/event/`));
    if (eventPanel && topic === `${eventPanel.nodeName}/event/page/favs`) {
      this.publishPanelFavorites(eventPanel);
      await this.publishPanelFavoriteState(eventPanel, config.panelBindings, instances);
    }
    if (eventPanel && isPanelPageEvent(eventPanel, topic)) {
      this.nativePanelPages.delete(eventPanel.id);
      const page = topic.slice(`${eventPanel.nodeName}/event/page/`.length);
      const session = this.runtimeState.getPanelSession(eventPanel.id);
      if (page === "page0" && session?.ancestors?.length) {
        await this.restoreParentPanelFlow(eventPanel, config.panelBindings, instances, session);
      } else if (page === "page0" && session?.favoritePanelPage) {
        await this.runtimeState.setPanelSession(eventPanel.id);
      } else if (page === "pageLevel" && session?.favoritePanelPage === "level") {
        // Firmware page navigation clears script page state while retaining the
        // native favorite-page owner so its level queries and state refreshes work.
        await this.runtimeState.setPanelSession(eventPanel.id, { ...session, screen: undefined, history: [] });
      } else if (page === "pageLevel" && session?.menuPageActive && this.isMenuFlow(session, instances)) {
        // A nonzero favorite mode enters pageLevel before publishing its selected row query.
        await this.runtimeState.setPanelSession(eventPanel.id, { ...session, screen: undefined, history: [] });
      } else if (page === "pageUniversal" && session && this.isMenuFlow(session, instances)) {
        // The firmware menu is active, but it is not a script-owned page.
        await this.runtimeState.setPanelSession(eventPanel.id, { ...session, screen: undefined, menuPageActive: true, history: [] });
      } else {
        await this.clearActivePluginPage(eventPanel);
      }
      this.updateHomeTilePageFromPanelEvent(eventPanel, message);
    }
    if (eventPanel && topic === `${eventPanel.nodeName}/event/query` && payload.trim().toLowerCase() === "main") {
      this.panelHomeTilePages.set(eventPanel.id, { page: "home" });
      await this.refreshAllHomeTiles(eventPanel);
    }
    if (eventPanel && topic === `${eventPanel.nodeName}/event/display` && (payload === "booted" || payload === "sleep")) {
      this.nativePanelPages.delete(eventPanel.id);
      this.panelHomeTilePages.delete(eventPanel.id);
      if (payload === "booted") this.publishedPanelFavoriteStates.delete(eventPanel.id);
    }

    await this.dispatchPluginMessage(instances, message);
    await this.dispatchPluginSubscriptions(instances, message);
    if (eventPanel) await this.dispatchNativePanelEvent(eventPanel, message, instances);
    if (eventPanel) await this.dispatchPanelEventObservers(eventPanel, message, instances);
    const favoritePageHandled = eventPanel ? await this.dispatchFavoritePanelEvent(eventPanel, message, instances, config.panelBindings) : false;
    if (eventPanel && !favoritePageHandled) await this.dispatchHomeTileEvent(eventPanel, message, instances);

    if (eventPanel && topic === `${eventPanel.nodeName}/event/display` && payload === "booted") {
      this.publishPanelSettings(eventPanel, true);
      await this.refreshNativePanel(eventPanel);
      this.panelHomeTilePages.set(eventPanel.id, { page: "home" });
      await this.refreshAllHomeTiles(eventPanel);
      const currentSession = this.runtimeState.getPanelSession(eventPanel.id);
      if (currentSession && !currentSession.screen) await this.runtimeState.setPanelSession(eventPanel.id);
      await this.restorePanelSession(eventPanel, config.panelBindings, instances);
    } else if (eventPanel && topic === `${eventPanel.nodeName}/event/display` && payload === "sleep") {
      // Stop pushing device telemetry to a panel once its firmware reports that
      // it has gone to sleep. The latest plugin state remains cached; the next
      // favorite press renders it when the user returns.
      await this.runtimeState.setPanelSession(eventPanel.id);
    } else if (eventPanel) {
      const event = this.panelProtocol.decodeEvent(eventPanel.nodeName, topic, payload);
      if (event) await this.handlePanelInput(eventPanel, event, config.panelBindings, instances);
    }

    for (const route of config.routes) {
      if (!matchesTopic(route.sourceTopic, topic)) continue;
      if (!matchesPayloadFilter(route.payloadFilter, payload)) continue;
      if (route.direction === "panel-to-external" && !eventPanel) continue;
      if (route.direction === "external-to-panel" && eventPanel) continue;
      this.applyRoute(route, topic, payload, eventPanel, config.panels);
    }
  }

  /** Applies panel LWT status and ping packets to the in-memory connection view. */
  private updatePanelConnection(topic: string, payload: string, receivedAt: number, panels: Panel[]): void {
    const panel = panels.find((candidate) => topic === `${candidate.nodeName}/status` || topic === `${candidate.nodeName}/event/ping`);
    if (!panel) return;

    const previous = this.panelConnections.get(panel.nodeName);
    if (topic === `${panel.nodeName}/status`) {
      const normalized = payload.trim().toLowerCase();
      if (normalized !== "online" && normalized !== "offline") return;
      this.panelConnections.set(panel.nodeName, {
        status: normalized,
        lastSeenAt: normalized === "online" ? receivedAt : previous?.lastSeenAt ?? null
      });
      return;
    }

    this.panelConnections.set(panel.nodeName, { status: "online", lastSeenAt: receivedAt });
  }

  private async dispatchPluginMessage(instances: ResolvedPluginInstance[], message: MqttMessageEnvelope): Promise<void> {
    for (const instance of instances) {
      if (!instance.enabled) continue;
      const definition = this.plugins.get(instance.pluginId);
      if (!definition || !definition.subscriptions(instance).some((filter) => matchesTopic(filter, message.topic))) continue;
      const previousState = this.runtimeState.getPluginState(instance.id);
      const patch = definition.decodeMessage(instance, message, previousState);
      if (!patch || Object.keys(patch).length === 0) continue;
      const state = { ...previousState, ...patch };
      await this.setPluginState(instance, state);
      await this.refreshBoundPanels(instance, state);
      await this.refreshNativePanelStates(instance, state);
      await this.refreshAssignedPanelStates(instance, state, previousState, patch);
      await this.refreshHomeTileStates(instance, state);
    }
  }

  /** Notifies each active plugin once after the shared broker connection is ready. */
  private async notifyPluginsConnected(): Promise<void> {
    const instancesByDefinition = new Map<PluginDefinition, ResolvedPluginInstance[]>();
    for (const instance of this.resolvePluginInstances()) {
      if (!instance.enabled) continue;
      const definition = this.plugins.get(instance.pluginId);
      if (!definition?.onMqttConnected) continue;
      const instances = instancesByDefinition.get(definition) ?? [];
      instances.push(instance);
      instancesByDefinition.set(definition, instances);
    }

    for (const [definition, instances] of instancesByDefinition) {
      try {
        await definition.onMqttConnected?.(instances, (topic, payload) => this.publish(topic, payload));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.lastError = detail;
        this.logger.error("Plugin broker-connected handler failed.", {
          component: "plugin",
          plugin: definition.name,
          phase: "mqtt-connected",
          detail
        });
      }
    }
  }

  /** Starts one immediate refresh and an unref'ed interval for a polling plugin instance. */
  private startPluginPoll(instance: ResolvedPluginInstance, definition: PluginDefinition): void {
    const intervalMs = definition.pollIntervalMs?.(instance);
    if (!definition.poll || typeof intervalMs !== "number" || !Number.isFinite(intervalMs) || intervalMs < 1_000 || intervalMs > 86_400_000) return;
    void this.pollPluginInstance(instance.id);
    const timer = setInterval(() => { void this.pollPluginInstance(instance.id); }, intervalMs);
    timer.unref();
    this.pluginPollTimers.set(instance.id, timer);
  }

  /** Fetches and dispatches one service plugin's normalized state update. */
  private async pollPluginInstance(instanceId: string): Promise<void> {
    if (this.closing || this.pollingPlugins.has(instanceId)) return;
    const instance = this.resolvePluginInstances().find((candidate) => candidate.id === instanceId && candidate.enabled);
    const definition = instance && this.plugins.get(instance.pluginId);
    if (!instance || !definition?.poll) return;
    this.pollingPlugins.add(instanceId);
    try {
      const previousState = this.runtimeState.getPluginState(instance.id);
      const patch = await definition.poll(instance, previousState);
      if (this.closing || !patch || Object.keys(patch).length === 0) return;
      const nextState = { ...previousState, ...patch };
      await this.setPluginState(instance, nextState);
      await this.refreshBoundPanels(instance, nextState);
      await this.refreshNativePanelStates(instance, nextState);
      await this.refreshAssignedPanelStates(instance, nextState, previousState, patch);
      await this.refreshHomeTileStates(instance, nextState);
    } catch (error) {
      if (this.closing) return;
      const detail = error instanceof Error ? error.message : String(error);
      this.lastError = detail;
      this.logger.error("Plugin service refresh failed.", {
        component: "plugin", instance: instance.name, phase: "poll", detail
      });
    } finally {
      this.pollingPlugins.delete(instanceId);
    }
  }

  /** Clears a service polling interval when an instance is disabled, changed, removed, or shut down. */
  private clearPluginPoll(instanceId: string): void {
    const timer = this.pluginPollTimers.get(instanceId);
    if (timer) clearInterval(timer);
    this.pluginPollTimers.delete(instanceId);
  }

  /** Runs the configured plugin integration for one firmware-native panel event. */
  private async dispatchNativePanelEvent(panel: Panel, message: MqttMessageEnvelope, instances: ResolvedPluginInstance[]): Promise<void> {
    for (const [pageId, instanceId] of Object.entries(panel.nativePluginInstances ?? {})) {
      const owner = instances.find((candidate) => candidate.id === instanceId && candidate.enabled);
      const definition = owner && this.plugins.get(owner.pluginId);
      if (!owner || !definition || definition.nativePanelPage !== pageId) continue;

      const transition = definition.nativePanelTransition?.(owner, panel, message);
      if (transition === "open") this.nativePanelPages.set(panel.id, pageId);
      else if (transition === "close") {
        if (this.nativePanelPages.get(panel.id) === pageId) this.nativePanelPages.delete(panel.id);
        continue;
      }
      if (this.nativePanelPages.get(panel.id) !== pageId) continue;

      const sharedEventInstances = definition.nativePanelSharedInstances
        ? instances.filter((candidate) => candidate.enabled && candidate.pluginId === owner.pluginId)
        : [owner];
      const eventInstances = definition.nativePanelEventTargets?.(sharedEventInstances, panel, message) ?? sharedEventInstances;
      let ownerState = this.runtimeState.getPluginState(owner.id);
      let ownerStateChanged = false;
      for (const instance of eventInstances) {
        const instanceDefinition = this.plugins.get(instance.pluginId);
        if (!instanceDefinition?.handleNativePanelEvent) continue;
        try {
          const previousState = this.runtimeState.getPluginState(instance.id);
          const result = await instanceDefinition.handleNativePanelEvent(instance, panel, message, previousState, sharedEventInstances);
          const nextState = result?.statePatch ? { ...previousState, ...result.statePatch } : previousState;
          if (result?.statePatch) await this.setPluginState(instance, nextState);
          if (instance.id === owner.id && result?.statePatch) {
            ownerState = nextState;
            ownerStateChanged = true;
          }
          for (const command of result?.commands ?? []) {
            if (isPublishableTopic(command.topic)) this.publish(command.topic, command.payload);
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.lastError = detail;
          this.logger.error("Native panel plugin event failed.", {
            component: "plugin", instance: instance.name, panel: panel.name, phase: "native panel event", topic: message.topic, detail
          });
        }
      }
      if (transition === "open" || ownerStateChanged) await this.publishNativePanelState(definition, owner, panel, ownerState);
    }
  }

  /** Runs explicitly assigned observer plugins for a panel's page-change events. */
  private async dispatchPanelEventObservers(panel: Panel, message: MqttMessageEnvelope, instances: ResolvedPluginInstance[]): Promise<void> {
    if (!message.topic.startsWith(`${panel.nodeName}/event/page/`)) return;
    for (const [pluginId, instanceId] of Object.entries(panel.panelEventPluginInstances ?? {})) {
      const instance = instances.find((candidate) => candidate.id === instanceId && candidate.enabled);
      const definition = instance && this.plugins.get(instance.pluginId);
      if (!instance || definition?.id !== pluginId || !definition.panelEventObserver || !definition.handlePanelEvent) continue;
      try {
        const commands = await definition.handlePanelEvent(instance, panel, message);
        for (const command of commands ?? []) {
          if (isPublishableTopic(command.topic)) this.publish(command.topic, command.payload);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.lastError = detail;
        this.logger.error("Panel event observer failed.", {
          component: "plugin", instance: instance.name, panel: panel.name, phase: "panel event observer", topic: message.topic, detail
        });
      }
    }
  }

  /** Routes panel tile, light-page, and level-page events to the assigned tile plugin. */
  private async dispatchHomeTileEvent(panel: Panel, message: MqttMessageEnvelope, instances: ResolvedPluginInstance[]): Promise<void> {
    const eventPrefix = `${panel.nodeName}/event/`;
    if (!message.topic.startsWith(eventPrefix)) return;
    const suffix = message.topic.slice(eventPrefix.length);
    const itemMatch = /^item\/([0-3])$/.exec(suffix);
    const levelQueryMatch = /^level\/([0-3])$/.exec(suffix);
    const levelSetMatch = /^level\/set\/([0-3])$/.exec(suffix);
    let index: number | undefined;
    if (itemMatch) index = Number(itemMatch[1]);
    else if (levelQueryMatch) index = Number(levelQueryMatch[1]);
    else if (levelSetMatch) index = Number(levelSetMatch[1]);
    else if (["colorLamp", "colorLamp/set", "colorscene", "page/colorlamp"].includes(suffix)) {
      const current = this.panelHomeTilePages.get(panel.id);
      if (current?.page === "light") index = current.index;
    }
    if (["colorLamp", "colorLamp/set"].includes(suffix)) {
      const requestedTopic = readPayloadRecord(message.payload)?.["topic"];
      if (typeof requestedTopic === "string") {
        index = this.findLightTileIndex(panel, instances, requestedTopic, index);
      }
    }
    if (index === undefined) return;

    const button = panel.settings.buttons[index];
    const instance = button?.pluginInstanceId
      ? instances.find((candidate) => candidate.id === button.pluginInstanceId && candidate.enabled)
      : undefined;
    const definition = instance && this.plugins.get(instance.pluginId);
    const isLevelPageQuery = Boolean(levelQueryMatch && message.payload.trim().toLowerCase() === "query");
    if (isLevelPageQuery) {
      this.logger.info("Received panel level-page query.", {
        component: "plugin",
        phase: "level page query",
        panel: panel.name,
        nodeName: panel.nodeName,
        topic: message.topic,
        buttonIndex: String(index),
        buttonLabel: button?.label ?? "",
        pluginInstanceId: button?.pluginInstanceId ?? "",
        instance: instance?.name ?? "",
        pluginId: instance?.pluginId ?? "",
        pluginProfileId: instance?.pluginProfileId ?? "",
        configuredPresets: instance ? String(instance.config["presets"] ?? "") : "",
        cachedPosition: instance ? String(this.runtimeState.getPluginState(instance.id).position ?? "") : ""
      });
    }
    if (!button?.pluginInstanceId) return;
    if (!instance || !definition?.handleHomeTileEvent) return;
    if (levelQueryMatch || levelSetMatch) this.panelHomeTilePages.set(panel.id, { page: "level", index });

    try {
      const previousState = this.runtimeState.getPluginState(instance.id);
      const result = await definition.handleHomeTileEvent(
        instance,
        panel,
        index,
        button,
        message,
        previousState,
        this.createPluginLifecycleContext(instance, "home tile")
      );
      if (!result) return;
      const nextState = result.statePatch ? { ...previousState, ...result.statePatch } : previousState;
      if (result.statePatch) await this.setPluginState(instance, nextState);
      for (const command of result.commands ?? []) {
        if (!isPublishableTopic(command.topic)) continue;
        const published = this.publish(command.topic, command.payload);
        if (isLevelPageQuery && command.topic === `${panel.nodeName}/cmnd/level/config`) {
          this.logger.info("Publishing level-page configuration for panel query.", {
            component: "plugin",
            phase: "level page query",
            panel: panel.name,
            nodeName: panel.nodeName,
            topic: message.topic,
            commandTopic: command.topic,
            instance: instance.name,
            pluginId: instance.pluginId,
            pluginProfileId: instance.pluginProfileId,
            buttonIndex: String(index),
            payload: command.payload,
            publishIssued: String(published)
          });
        }
      }
      if (result.page === "closed") this.panelHomeTilePages.delete(panel.id);
      else if (result.page) this.panelHomeTilePages.set(panel.id, { page: result.page, ...(result.page === "home" ? {} : { index }) });
      const activePage = this.panelHomeTilePages.get(panel.id);
      if (activePage) {
        if (activePage.page === "home") await this.refreshAllHomeTiles(panel);
        else if (activePage.index === index) await this.renderHomeTile(instance, panel, index, activePage.page, nextState);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.lastError = detail;
      this.logger.error("Home tile plugin event failed.", {
        component: "plugin", instance: instance.name, panel: panel.name, phase: "home tile event", topic: message.topic, detail
      });
    }
  }

  /** Finds the panel tile instance whose resolved set topic matches a light event endpoint. */
  private findLightTileIndex(panel: Panel, instances: ResolvedPluginInstance[], topic: string, preferredIndex?: number): number | undefined {
    const matches = (index: number): boolean => {
      const instanceId = panel.settings.buttons[index]?.pluginInstanceId;
      const instance = instances.find((candidate) => candidate.id === instanceId && candidate.enabled && candidate.pluginId === "mqtt-light");
      const setTopic = instance?.config["setTopic"];
      if (!instance || typeof setTopic !== "string") return false;
      return interpolatePluginTemplate(setTopic, instance.variables) === topic;
    };
    if (preferredIndex !== undefined && matches(preferredIndex)) return preferredIndex;
    const found = panel.settings.buttons.findIndex((_button, index) => matches(index));
    return found < 0 ? undefined : found;
  }

  /** Tracks firmware navigation that changes which home tile may receive state updates. */
  private updateHomeTilePageFromPanelEvent(panel: Panel, message: MqttMessageEnvelope): void {
    const page = message.topic.slice(`${panel.nodeName}/event/page/`.length);
    if (page === "page0") {
      this.panelHomeTilePages.set(panel.id, { page: "home" });
      return;
    }
    if (page === "pageLevel") {
      this.panelHomeTilePages.set(panel.id, { page: "level" });
      return;
    }
    if (page === "pageColorLight" || page === "colorlamp") return;
    this.panelHomeTilePages.delete(panel.id);
  }

  /** Sends current state to every configured tile when the panel home screen is active. */
  private async refreshAllHomeTiles(panel: Panel): Promise<void> {
    for (const [index, button] of panel.settings.buttons.entries()) {
      if (!button.pluginInstanceId) continue;
      const instance = this.resolvePluginInstances().find((candidate) => candidate.id === button.pluginInstanceId && candidate.enabled);
      const definition = instance && this.plugins.get(instance.pluginId);
      if (!instance || !definition?.renderHomeTileState) continue;
      await this.renderHomeTile(instance, panel, index, "home", this.runtimeState.getPluginState(instance.id));
    }
  }

  /** Refreshes matching tiles only when the device's tile page is visible. */
  private async refreshHomeTileStates(instance: ResolvedPluginInstance, state: PluginState): Promise<void> {
    const definition = this.plugins.get(instance.pluginId);
    if (!definition?.renderHomeTileState) return;
    for (const panel of this.store.get().panels) {
      const active = this.panelHomeTilePages.get(panel.id);
      if (!active) continue;
      for (const [index, button] of panel.settings.buttons.entries()) {
        if (button.pluginInstanceId !== instance.id) continue;
        if (active.page !== "home" && active.index !== index) continue;
        await this.renderHomeTile(instance, panel, index, active.page, state);
      }
    }
  }

  /** Publishes one plugin's translated tile state through the shared broker connection. */
  private async renderHomeTile(instance: ResolvedPluginInstance, panel: Panel, index: number, page: "home" | "light" | "level", state: PluginState): Promise<void> {
    const definition = this.plugins.get(instance.pluginId);
    const button = panel.settings.buttons[index];
    if (!definition?.renderHomeTileState || !button) return;
    try {
      for (const command of definition.renderHomeTileState(instance, panel, index, button, page, state)) {
        if (isPublishableTopic(command.topic)) this.publish(command.topic, command.payload);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error("Home tile state render failed.", {
        component: "plugin", instance: instance.name, panel: panel.name, phase: "home tile render", detail
      });
    }
  }

  /** Pushes native-page state to the active page, including integrations that opt into background updates. */
  private async refreshNativePanelStates(instance: ResolvedPluginInstance, state: PluginState): Promise<void> {
    const changedDefinition = this.plugins.get(instance.pluginId);
    const pageId = changedDefinition?.nativePanelPage;
    if (!changedDefinition?.renderNativePanelState || !pageId) return;
    const instances = this.resolvePluginInstances();
    for (const panel of this.store.get().panels) {
      const assignedId: string | undefined = panel.nativePluginInstances?.[pageId];
      const assigned: ResolvedPluginInstance | undefined = instances.find((candidate) => candidate.id === assignedId && candidate.enabled);
      const definition: PluginDefinition | undefined = assigned ? this.plugins.get(assigned.pluginId) : undefined;
      if (!assigned || !definition?.renderNativePanelState || definition.nativePanelPage !== pageId) continue;
      const contributesToSharedPage = definition.nativePanelSharedInstances && assigned.pluginId === instance.pluginId;
      const pageIsOpen = this.nativePanelPages.get(panel.id) === pageId;
      if ((!contributesToSharedPage && assigned.id !== instance.id) || (!pageIsOpen && !definition.nativePanelStateUpdatesWhenClosed)) continue;
      const assignedState = assigned.id === instance.id ? state : this.runtimeState.getPluginState(assigned.id);
      await this.publishNativePanelState(definition, assigned, panel, assignedState);
    }
  }

  /** Sends changed device values to panels assigned to the plugin's native page, regardless of page visibility. */
  private async refreshAssignedPanelStates(instance: ResolvedPluginInstance, state: PluginState, previousState: PluginState, change: PluginState): Promise<void> {
    const definition = this.plugins.get(instance.pluginId);
    const pageId = definition?.nativePanelPage;
    if (!definition || !pageId) return;
    for (const panel of this.store.get().panels) {
      if (panel.nativePluginInstances?.[pageId] !== instance.id) continue;
      await this.publishAssignedPanelState(definition, instance, panel, state, previousState, change);
    }
  }

  /** Publishes plugin state intended for the panel beyond its currently visible plugin page. */
  private async publishAssignedPanelState(definition: PluginDefinition, instance: ResolvedPluginInstance, panel: Panel, state: PluginState, previousState: PluginState, change: PluginState): Promise<void> {
    if (!definition.renderPanelState) return;
    try {
      for (const command of definition.renderPanelState(instance, panel, state, previousState, change)) {
        if (isPublishableTopic(command.topic)) this.publish(command.topic, command.payload);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error("Assigned panel plugin state update failed.", {
        component: "plugin", instance: instance.name, panel: panel.name, phase: "assigned panel state", detail
      });
    }
  }

  /** Publishes a native-page plugin's translated state through the shared broker connection. */
  private async publishNativePanelState(definition: PluginDefinition, instance: ResolvedPluginInstance, panel: Panel, state: PluginState): Promise<void> {
    if (!definition.renderNativePanelState) return;
    try {
      const relatedInstances: readonly PluginNativePanelInstanceState[] | undefined = definition.nativePanelSharedInstances
        ? this.resolvePluginInstances().filter((candidate) => candidate.enabled && candidate.pluginId === instance.pluginId).map((candidate) => ({
            instance: candidate,
            state: candidate.id === instance.id ? state : this.runtimeState.getPluginState(candidate.id)
          }))
        : undefined;
      for (const command of definition.renderNativePanelState(instance, panel, state, relatedInstances)) {
        if (isPublishableTopic(command.topic)) this.publish(command.topic, command.payload);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error("Native panel plugin state update failed.", {
        component: "plugin", instance: instance.name, panel: panel.name, phase: "native panel render", detail
      });
    }
  }

  /** Invokes every dynamic startup callback whose topic filter matches this packet. */
  private async dispatchPluginSubscriptions(instances: ResolvedPluginInstance[], message: MqttMessageEnvelope): Promise<void> {
    for (const instance of instances) {
      if (!instance.enabled) continue;
      const definition = this.plugins.get(instance.pluginId);
      if (!definition?.handleSubscription) continue;
      const subscriptions = this.pluginSubscriptions.get(instance.id) ?? [];
      for (const subscription of subscriptions) {
        if (!matchesTopic(subscription.topicFilter, message.topic)) continue;
        try {
          const result = await definition.handleSubscription(
            instance,
            subscription,
            message,
            this.runtimeState.getPluginState(instance.id),
            this.createPluginLifecycleContext(instance, "mqtt subscription")
          );
          if (result?.statePatch) {
            const state = { ...this.runtimeState.getPluginState(instance.id), ...result.statePatch };
            await this.setPluginState(instance, state);
          }
          for (const command of result?.commands ?? []) {
            if (isPublishableTopic(command.topic)) this.publish(command.topic, command.payload);
          }
          if (result?.navigation) await this.navigateActivePluginPanels(instance, result.navigation);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.lastError = detail;
          this.logger.error("Plugin MQTT callback failed.", {
            component: "plugin",
            instance: instance.name,
            phase: "mqtt subscription",
            topic: message.topic,
            detail
          });
        }
      }
    }
  }

  /** Applies a script-requested navigation to every active panel using this plugin instance. */
  private async navigateActivePluginPanels(instance: ResolvedPluginInstance, navigation: PluginPageNavigation): Promise<void> {
    const config = this.store.get();
    const state = this.runtimeState.getPluginState(instance.id);
    for (const panel of config.panels) {
      const session = this.runtimeState.getPanelSession(panel.id);
      const binding = session && this.resolveSessionBinding(panel, session, config.panelBindings);
      if (!session || !binding || session.pluginInstanceId !== instance.id) continue;
      if (navigation.type === "reload" && navigation.screen === undefined && !session.screen) continue;
      const screen = navigation.screen ?? session.screen;
      if (!screen) continue;
      const history = [...(session.history ?? [])];
      if (navigation.type === "go" && session.screen && screen !== session.screen) history.push(session.screen);
      await this.runtimeState.setPanelSession(panel.id, { ...session, screen, history });
      await this.showScreen(panel, binding, instance, state, screen);
    }
  }

  /** Refreshes only plugin screens with an active user session on the matching panel. */
  private async refreshBoundPanels(instance: ResolvedPluginInstance, state: PluginState): Promise<void> {
    const config = this.store.get();
    for (const panel of config.panels) {
      const session = this.runtimeState.getPanelSession(panel.id);
      const binding = session && this.resolveSessionBinding(panel, session, config.panelBindings);
      if (!session || session.pluginInstanceId !== instance.id || !binding) continue;
      const definition = this.plugins.get(instance.pluginId);
      if (session.favoritePanelPage && definition?.renderFavoritePanelState) {
        this.publishFavoritePanelState(definition, instance, panel, state);
      } else if (session.screen) {
        await this.showScreen(panel, binding, instance, state, session.screen);
      }
    }
  }

  /** Clears a panel's plugin page after firmware navigation leaves plugin-managed screens. */
  private async clearActivePluginPage(panel: Panel): Promise<void> {
    this.nativePanelPages.delete(panel.id);
    const session = this.runtimeState.getPanelSession(panel.id);
    if (!session) return;
    await this.runtimeState.setPanelSession(panel.id, {
      ...session,
      screen: undefined,
      menuPageActive: undefined,
      favoritePanelPage: undefined,
      history: [],
      ancestors: []
    });
  }

  /** Restores the parent menu or plugin page after firmware Back navigation. */
  private async restoreParentPanelFlow(panel: Panel, bindings: PanelBinding[], instances: ResolvedPluginInstance[], session: PanelFlowSession): Promise<void> {
    const ancestors = [...(session.ancestors ?? [])];
    const parent = ancestors.pop();
    const parentInstance = parent && instances.find((candidate) => candidate.id === parent.pluginInstanceId && candidate.enabled);
    const parentBinding = parent && this.resolveSessionBinding(panel, parent, bindings);
    if (!parent || !parentInstance || !parentBinding) {
      await this.runtimeState.setPanelSession(panel.id);
      this.panelProtocol.exitToHome(panel);
      return;
    }
    const definition = this.plugins.get(parentInstance.pluginId);
    const screen = parent.screen ?? definition?.startScreen?.(parentInstance) ?? "overview";
    const restored: PanelFlowSession = { ...parent, screen, ancestors };
    await this.runtimeState.setPanelSession(panel.id, restored);
    await this.renderBinding(panel, parentBinding, parentInstance, screen);
  }

  /** Handles page-level queries and controls owned by an active favorite plugin page. */
  private async dispatchFavoritePanelEvent(panel: Panel, message: MqttMessageEnvelope, instances: ResolvedPluginInstance[], bindings: PanelBinding[]): Promise<boolean> {
    const prefix = `${panel.nodeName}/event/`;
    if (!message.topic.startsWith(prefix)) return false;
    const suffix = message.topic.slice(prefix.length);
    const levelQuery = /^level\/(\d{1,2})$/.exec(suffix);
    const levelSet = /^level\/set\/(\d{1,2})$/.exec(suffix);
    if (!levelQuery && !levelSet) return false;

    const session = this.runtimeState.getPanelSession(panel.id);
    if (!session) return false;
    const instance = instances.find((candidate) => candidate.id === session.pluginInstanceId && candidate.enabled);
    const definition = instance && this.plugins.get(instance.pluginId);
    const binding = this.resolveSessionBinding(panel, session, bindings);
    if (!instance || !definition || !binding) return false;

    if (session.favoritePanelPage && definition.handleFavoritePanelEvent) {
      try {
        const previousState = this.runtimeState.getPluginState(instance.id);
        const result = await definition.handleFavoritePanelEvent(instance, panel, binding, message, previousState);
        if (!result) return Boolean(levelQuery || levelSet);
        const nextState = result.statePatch ? { ...previousState, ...result.statePatch } : previousState;
        if (result.statePatch) await this.setPluginState(instance, nextState);
        for (const command of result.commands ?? []) {
          if (isPublishableTopic(command.topic)) this.publish(command.topic, command.payload);
        }
        if (result.statePatch && definition.renderFavoritePanelState) this.publishFavoritePanelState(definition, instance, panel, nextState);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.lastError = detail;
        this.logger.error("Favorite panel plugin event failed.", {
          component: "plugin", instance: instance.name, panel: panel.name, phase: "favorite panel event", topic: message.topic, detail
        });
      }
      return true;
    }

    // A nonzero firmware favorite mode skips event/favorites/N and enters the
    // level page directly. Firmware offsets favorite rows by four; accept an
    // unoffset index too for panels whose selectedIndex has already been fixed.
    if (levelQuery && message.payload.trim().toLowerCase() === "query" && definition.handleMenuPageAction && session.menuPageActive) {
      const selectedIndex = Number(levelQuery[1]);
      const menuIndex = selectedIndex >= 4 && selectedIndex <= 15 ? selectedIndex - 4 : selectedIndex;
      await this.openMenuTarget(panel, session, binding, instance, definition, menuIndex, instances);
      return true;
    }
    return false;
  }

  /** Opens the configured plugin instance selected from a plugin-owned menu. */
  private async openMenuTarget(panel: Panel, session: PanelFlowSession, binding: PanelBinding, source: ResolvedPluginInstance, sourceDefinition: PluginDefinition, index: number, instances: ResolvedPluginInstance[]): Promise<void> {
    if (!Number.isInteger(index) || index < 0 || index > 11 || !sourceDefinition.handleMenuPageAction || (session.ancestors?.length ?? 0) >= 8) return;
    const result = await sourceDefinition.handleMenuPageAction(source, index, this.createPluginContext(panel, binding, source));
    const target = result?.targetPluginInstanceId && instances.find((candidate) => candidate.id === result.targetPluginInstanceId && candidate.enabled);
    const targetDefinition = target && this.plugins.get(target.pluginId);
    if (!target || !targetDefinition || !targetDefinition.favoriteFlow || targetDefinition.nativePanelPage) return;

    const targetBinding: PanelBinding = {
      id: randomUUID(), name: target.name, panelId: panel.id,
      pluginInstanceId: target.id, trigger: binding.trigger
    };
    const ancestors = [...(session.ancestors ?? []), {
      bindingId: session.bindingId,
      pluginInstanceId: session.pluginInstanceId,
      screen: session.screen,
      ...(session.menuPageActive ? { menuPageActive: session.menuPageActive } : {}),
      ...(session.favoritePanelPage ? { favoritePanelPage: session.favoritePanelPage } : {}),
      history: session.history ?? [],
      ...(session.flowBinding ? { flowBinding: session.flowBinding } : {})
    }];
    const screen = targetDefinition.startScreen?.(target) ?? "overview";
    await this.runtimeState.setPanelSession(panel.id, {
      bindingId: targetBinding.id,
      pluginInstanceId: target.id,
      screen,
      ...(targetDefinition.renderMenuPage ? { menuPageActive: true } : {}),
      ...(targetDefinition.favoritePanelPage ? { favoritePanelPage: targetDefinition.favoritePanelPage } : {}),
      history: [],
      flowBinding: targetBinding,
      ancestors
    });
    await this.renderBinding(panel, targetBinding, target, screen);
  }

  /** Sends a favorite native page's normalized state only while that flow is active. */
  private publishFavoritePanelState(definition: PluginDefinition, instance: ResolvedPluginInstance, panel: Panel, state: PluginState): void {
    if (!definition.renderFavoritePanelState) return;
    try {
      for (const command of definition.renderFavoritePanelState(instance, panel, state)) {
        if (isPublishableTopic(command.topic)) this.publish(command.topic, command.payload);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error("Favorite panel plugin state update failed.", {
        component: "plugin", instance: instance.name, panel: panel.name, phase: "favorite panel render", detail
      });
    }
  }

  /** Identifies a visible firmware-native menu owned by a configured flow plugin. */
  private isMenuFlow(session: PanelFlowSession, instances: ResolvedPluginInstance[]): boolean {
    const instance = instances.find((candidate) => candidate.id === session.pluginInstanceId && candidate.enabled);
    return Boolean(instance && this.plugins.get(instance.pluginId)?.renderMenuPage);
  }

  private async handlePanelInput(panel: Panel, event: PanelInputEvent, bindings: PanelBinding[], instances: ResolvedPluginInstance[]): Promise<void> {
    if (event.type === "favorite") {
      const activeMenu = this.runtimeState.getPanelSession(panel.id);
      const menuInstance = activeMenu?.menuPageActive ? instances.find((item) => item.id === activeMenu.pluginInstanceId && item.enabled) : undefined;
      const menuDefinition = menuInstance ? this.plugins.get(menuInstance.pluginId) : undefined;
      const menuBinding = activeMenu && this.resolveSessionBinding(panel, activeMenu, bindings);
      if (activeMenu?.menuPageActive && menuInstance && menuDefinition?.renderMenuPage && menuDefinition.handleMenuPageAction && menuBinding) {
        await this.openMenuTarget(panel, activeMenu, menuBinding, menuInstance, menuDefinition, event.index, instances);
        return;
      }

      const binding = bindings.find((item) => item.panelId === panel.id && item.trigger.type === "favorite" && item.trigger.index === event.index);
      const instance = binding && instances.find((item) => item.id === binding.pluginInstanceId && item.enabled);
      const definition = instance && this.plugins.get(instance.pluginId);
      if (!binding || !instance || !definition) return;
      const startScreen = definition.startScreen?.(instance) ?? "overview";
      await this.runtimeState.setPanelSession(panel.id, {
        bindingId: binding.id,
        pluginInstanceId: instance.id,
        screen: startScreen,
        ...(definition.renderMenuPage ? { menuPageActive: true } : {}),
        ...(definition.favoritePanelPage ? { favoritePanelPage: definition.favoritePanelPage } : {}),
        history: []
      });
      await this.renderBinding(panel, binding, instance, startScreen);
      return;
    }

    const session = this.runtimeState.getPanelSession(panel.id);
    if (event.type === "favorite-menu-button" && session?.menuPageActive && session.bindingId === event.bindingId) {
      const menuBinding = this.resolveSessionBinding(panel, session, bindings);
      const menuInstance = instances.find((item) => item.id === session.pluginInstanceId && item.enabled);
      const menuDefinition = menuInstance && this.plugins.get(menuInstance.pluginId);
      if (menuBinding && menuInstance && menuDefinition?.renderMenuPage) {
        await this.openMenuTarget(panel, session, menuBinding, menuInstance, menuDefinition, event.index, instances);
      }
      return;
    }
    if (!session?.screen || session.bindingId !== event.bindingId) return;
    const binding = this.resolveSessionBinding(panel, session, bindings);
    const instance = instances.find((item) => item.id === session.pluginInstanceId && item.enabled);
    const definition = instance && this.plugins.get(instance.pluginId);
    if (!binding || !instance || !definition) {
      await this.runtimeState.setPanelSession(panel.id);
      return;
    }

    if (event.type === "info-back") {
      const startScreen = definition.startScreen?.(instance) ?? "overview";
      if (session.screen !== startScreen) {
        const history = [...(session.history ?? [])];
        const screen = history.pop() ?? startScreen;
        await this.runtimeState.setPanelSession(panel.id, { ...session, screen, history });
        await this.renderBinding(panel, binding, instance, screen);
      } else if (session.ancestors?.length) {
        const ancestors = [...session.ancestors];
        const parent = ancestors.pop()!;
        const parentInstance = instances.find((candidate) => candidate.id === parent.pluginInstanceId && candidate.enabled);
        const parentBinding = this.resolveSessionBinding(panel, parent, bindings);
        if (!parentInstance || !parentBinding) {
          await this.runtimeState.setPanelSession(panel.id);
          this.panelProtocol.exitToHome(panel);
          return;
        }
        const restored = { ...parent, ancestors };
        const parentScreen = parent.screen ?? (this.plugins.get(parentInstance.pluginId)?.startScreen?.(parentInstance) ?? "overview");
        await this.runtimeState.setPanelSession(panel.id, restored);
        await this.renderBinding(panel, parentBinding, parentInstance, parentScreen);
      } else {
        await this.runtimeState.setPanelSession(panel.id);
        this.panelProtocol.exitToHome(panel);
      }
      return;
    }

    if (event.type !== "info-button" || event.index < 0 || event.index > 7 || !event.action) return;
    const previousState = this.runtimeState.getPluginState(instance.id);
    const context = this.createPluginContext(panel, binding, instance);
    const result = await definition.handleAction(instance, previousState, event.action, context);
    const nextState = result.statePatch ? { ...previousState, ...result.statePatch } : previousState;
    if (result.statePatch) await this.setPluginState(instance, nextState);
    for (const command of result.commands ?? []) {
      if (isPublishableTopic(command.topic)) this.publish(command.topic, command.payload);
    }
    if (result.screen === "exit") {
      await this.runtimeState.setPanelSession(panel.id);
      this.panelProtocol.exitToHome(panel);
      return;
    }
    const history = [...(session.history ?? [])];
    if (result.navigation?.type !== "reload" && result.screen !== session.screen) history.push(session.screen);
    await this.runtimeState.setPanelSession(panel.id, { ...session, screen: result.screen, history });
    await this.showScreen(panel, binding, instance, nextState, result.screen);
  }

  private async restorePanelSession(panel: Panel, bindings: PanelBinding[], instances: ResolvedPluginInstance[]): Promise<void> {
    const session = this.runtimeState.getPanelSession(panel.id);
    if (!session) return;
    const binding = this.resolveSessionBinding(panel, session, bindings);
    const instance = instances.find((item) => item.id === session.pluginInstanceId && item.enabled);
    if (!binding || !instance || !this.plugins.get(instance.pluginId)) {
      await this.runtimeState.setPanelSession(panel.id);
      return;
    }
    if (!session.screen) return;
    await this.renderBinding(panel, binding, instance, session.screen);
  }

  /** Replays saved profiles and active plugin screens after a broker connection returns. */
  private async restoreAllPanels(): Promise<void> {
    const config = this.store.get();
    const instances = this.resolvePluginInstances(config);
    for (const panel of config.panels) {
      this.publishPanelSettings(panel);
      await this.publishPanelFavoriteState(panel, config.panelBindings, instances);
      await this.refreshNativePanel(panel);
      await this.refreshAllHomeTiles(panel);
      await this.restorePanelSession(panel, config.panelBindings, instances);
    }
  }

  private async renderBinding(panel: Panel, binding: PanelBinding, instance: ResolvedPluginInstance, screen: string): Promise<void> {
    const definition = this.plugins.get(instance.pluginId);
    if (definition) await this.showScreen(panel, binding, instance, this.runtimeState.getPluginState(instance.id), screen);
  }

  private async showScreen(panel: Panel, binding: PanelBinding, instance: ResolvedPluginInstance, state: PluginState, screen: string): Promise<void> {
    const definition: PluginDefinition | undefined = this.plugins.get(instance.pluginId);
    const isCurrentSession = (): boolean => {
      const current = this.runtimeState.getPanelSession(panel.id);
      return current?.bindingId === binding.id && current.pluginInstanceId === instance.id && current.screen === screen;
    };
    if (!definition || !isCurrentSession()) return;
    const context = this.createPluginContext(panel, binding, instance);
    if (definition.favoritePanelPage && definition.openFavoritePanelPage) {
      try {
        const result = await definition.openFavoritePanelPage(instance, panel, binding, state);
        if (!isCurrentSession()) return;
        if (result.statePatch) {
          await this.setPluginState(instance, { ...state, ...result.statePatch });
        }
        for (const command of result.commands ?? []) {
          if (isPublishableTopic(command.topic)) this.publish(command.topic, command.payload);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.lastError = detail;
        this.logger.error("Favorite panel page failed to open.", {
          component: "plugin", instance: instance.name, panel: panel.name, page: screen, phase: "favorite panel open", detail
        });
      }
      return;
    }
    if (definition.renderMenuPage) {
      try {
        const menu = await definition.renderMenuPage(instance, context);
        if (menu && isCurrentSession()) this.panelProtocol.showMenuPage(panel, menu);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.lastError = detail;
        this.logger.error("Plugin menu render failed.", {
          component: "plugin", instance: instance.name, panel: panel.name, page: screen, phase: "render", detail
        });
      }
      return;
    }
    let view: Awaited<ReturnType<PluginDefinition["renderScreen"]>>;
    try {
      view = await definition.renderScreen(instance, state, screen, context);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const lastMessage = state.lastMessage;
      const topic = typeof lastMessage === "object" && lastMessage !== null && "topic" in lastMessage &&
        typeof lastMessage.topic === "string" ? lastMessage.topic : "";
      this.lastError = detail;
      this.logger.error("Plugin page render failed.", {
        component: "plugin",
        instance: instance.name,
        panel: panel.name,
        page: screen,
        phase: "render",
        topic,
        detail
      });
      return;
    }
    // Rendering can yield to MQTT sleep/navigation events. Recheck so late
    // telemetry cannot wake the panel or overwrite a newer page.
    if (view && isCurrentSession()) this.panelProtocol.showScreen(panel, binding, view);
  }

  /** Resolves either the saved favorite binding or a synthetic nested-flow binding. */
  private resolveSessionBinding(panel: Panel, session: { bindingId: string; flowBinding?: PanelBinding }, bindings: PanelBinding[]): PanelBinding | undefined {
    const configured = bindings.find((item) => item.id === session.bindingId && item.panelId === panel.id);
    if (configured) return configured;
    return session.flowBinding?.id === session.bindingId && session.flowBinding.panelId === panel.id ? session.flowBinding : undefined;
  }

  private createPluginContext(panel: Panel, binding: PanelBinding, instance: ResolvedPluginInstance): PluginRuntimeContext {
    const ownerId = (scope: PluginStorageScope): string => scope === "global" ? "" : scope === "panel" ? panel.id : instance.id;
    const resolvePanelId = (panelNameOrId: string): string => {
      const matches = this.store.get().panels.filter((candidate) => candidate.id === panelNameOrId || candidate.name === panelNameOrId);
      if (matches.length !== 1) throw new Error(matches.length ? `Panel name '${panelNameOrId}' is ambiguous.` : `Panel '${panelNameOrId}' was not found.`);
      return matches[0].id;
    };
    return {
      panel: { id: panel.id, name: panel.name, nodeName: panel.nodeName },
      binding: { id: binding.id, name: binding.name, panelId: binding.panelId, pluginInstanceId: binding.pluginInstanceId, trigger: binding.trigger },
      variables: instance.variables ?? {},
      storage: {
        get: async (scope, key) => this.runtimeState.getValue(scope, ownerId(scope), key),
        set: async (scope, key, value) => this.runtimeState.setValue(scope, ownerId(scope), key, value),
        delete: async (scope, key) => this.runtimeState.deleteValue(scope, ownerId(scope), key),
        snapshot: async (scope) => this.runtimeState.getScopeValues(scope, ownerId(scope)),
        snapshotPanels: async () => this.getPanelStorageSnapshots(),
        setPanel: async (panelNameOrId, key, value) => this.runtimeState.setValue("panel", resolvePanelId(panelNameOrId), key, value),
        deletePanel: async (panelNameOrId, key) => this.runtimeState.deleteValue("panel", resolvePanelId(panelNameOrId), key)
      },
      publish: (topic, payload) => this.publish(topic, payload),
      debug: { log: (message) => this.logger.debug(message, { component: "plugin", instance: instance.name, phase: "panel", panel: panel.name }) }
    };
  }

  /** Creates the panel-independent context used by plugin startup and MQTT callbacks. */
  private createPluginLifecycleContext(instance: ResolvedPluginInstance, phase: string): PluginRuntimeContext {
    const resolvePanelId = (panelNameOrId: string): string => {
      const matches = this.store.get().panels.filter((candidate) => candidate.id === panelNameOrId || candidate.name === panelNameOrId);
      if (matches.length !== 1) throw new Error(matches.length ? `Panel name '${panelNameOrId}' is ambiguous.` : `Panel '${panelNameOrId}' was not found.`);
      return matches[0].id;
    };
    const ownerId = (scope: PluginStorageScope): string => scope === "global" ? "" : scope === "plugin" ? instance.id : "";
    return {
      panel: { id: "", name: instance.name, nodeName: "" },
      binding: {
        id: "", name: "Plugin startup", panelId: "", pluginInstanceId: instance.id,
        trigger: { type: "favorite", index: 0 }
      },
      variables: instance.variables ?? {},
      storage: {
        get: async (scope, key) => this.runtimeState.getValue(scope, ownerId(scope), key),
        set: async (scope, key, value) => {
          if (scope === "panel") throw new Error("Choose a panel by name with panel.set(panelName, key, value).");
          await this.runtimeState.setValue(scope, ownerId(scope), key, value);
        },
        delete: async (scope, key) => {
          if (scope === "panel") throw new Error("Choose a panel by name with panel.delete(panelName, key).");
          await this.runtimeState.deleteValue(scope, ownerId(scope), key);
        },
        snapshot: async (scope) => this.runtimeState.getScopeValues(scope, ownerId(scope)),
        snapshotPanels: async () => this.getPanelStorageSnapshots(),
        setPanel: async (panelNameOrId, key, value) => this.runtimeState.setValue("panel", resolvePanelId(panelNameOrId), key, value),
        deletePanel: async (panelNameOrId, key) => this.runtimeState.deleteValue("panel", resolvePanelId(panelNameOrId), key)
      },
      publish: (topic, payload) => this.publish(topic, payload),
      debug: { log: (message) => this.logger.debug(message, { component: "plugin", instance: instance.name, phase }) }
    };
  }

  private getPanelStorageSnapshots(): PanelStorageSnapshot[] {
    return this.store.get().panels.map((panel) => ({
      id: panel.id,
      name: panel.name,
      values: this.runtimeState.getScopeValues("panel", panel.id)
    }));
  }

  /** Resolves saved instance references against reusable plugin profiles for runtime calls. */
  private resolvePluginInstances(config: ManagerConfig = this.store.get()): ResolvedPluginInstance[] {
    const profiles = new Map(config.pluginProfiles.map((profile) => [profile.id, profile]));
    return config.pluginInstances.flatMap((instance) => {
      const profile = profiles.get(instance.pluginProfileId);
      return profile ? [{ ...instance, pluginId: profile.pluginId, config: profile.config }] : [];
    });
  }

  /** Forwards a route and gates direct panel screen commands on an open flow session. */
  private applyRoute(route: MqttRoute, topic: string, payload: string, eventPanel: Panel | undefined, panels: Panel[]): void {
    const routePanel = route.panelId ? panels.find((panel) => panel.id === route.panelId) : eventPanel;
    const nodeName = routePanel?.nodeName ?? eventPanel?.nodeName ?? "";
    const targetTopic = route.targetTopic.replaceAll("{nodeName}", nodeName);
    if (!targetTopic || targetTopic.includes("{nodeName}")) return;
    if (route.direction === "external-to-panel" && routePanel && (
      targetTopic === `${routePanel.nodeName}/cmnd/info` ||
      targetTopic === `${routePanel.nodeName}/cmnd/nextion`
    ) && !this.runtimeState.getPanelSession(routePanel.id)?.screen) return;
    const output = renderPayload(route.payloadTemplate, topic, payload, routePanel);
    this.publish(targetTopic, output);
  }

  private publish(topic: string, payload: string): boolean {
    if (!this.client?.connected || !isPublishableTopic(topic)) return false;
    this.client.publish(topic, payload);
    return true;
  }
}

function isPublishableTopic(topic: string): boolean { return Boolean(topic.trim()) && !/[+#\u0000]/.test(topic); }

/** Builds an HMI-safe initial song label from the cached Sonos state. */
function currentSonosSong(state: PluginState): string | undefined {
  if (state["playbackState"] === "stopped") return undefined;
  const title = firmwareSafeText(typeof state["title"] === "string" ? state["title"] : "");
  const artist = firmwareSafeText(typeof state["artist"] === "string" ? state["artist"] : "");
  if (!title && !artist) return undefined;
  return artist && title ? artist + "|" + title : artist || title;
}

/** Removes HMI command delimiters and control characters from firmware text fields. */
function firmwareSafeText(value: string): string {
  return value.replaceAll('"', "'").replaceAll("\\", " ").replace(/[\r\n\u0000-\u001f]/g, " ").trim();
}

function isPanelPageEvent(panel: Panel, topic: string): boolean {
  const pageTopic = `${panel.nodeName}/event/page`;
  return topic === pageTopic || topic.startsWith(`${pageTopic}/`);
}

function isValidTopicFilter(filter: string): boolean {
  if (!filter || filter.includes("\u0000")) return false;
  const levels = filter.split("/");
  return levels.every((level, index) => {
    if (level.includes("#")) return level === "#" && index === levels.length - 1;
    return !level.includes("+") || level === "+";
  });
}

function matchesTopic(filter: string, topic: string): boolean {
  const expected = filter.split("/");
  const actual = topic.split("/");
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] === "#") return true;
    if (i >= actual.length || (expected[i] !== "+" && expected[i] !== actual[i])) return false;
  }
  return expected.length === actual.length;
}

/** Parses a JSON object payload when panel routing needs a device endpoint. */
function readPayloadRecord(payload: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(payload);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

function renderPayload(template: string, topic: string, payload: string, panel?: Panel): string {
  const parsed = parseRoutePayloadJson(payload);
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, key: string) => {
    const lookup = key.trim();
    if (lookup === "payload") return payload;
    if (lookup === "topic") return topic;
    if (lookup === "nodeName") return panel?.nodeName ?? "";
    const value = lookup.startsWith("json.") ? lookup.slice(5).split(".").reduce<unknown>((current, part) => {
      if (current && typeof current === "object") return (current as Record<string, unknown>)[part];
      return undefined;
    }, parsed) : undefined;
    return value === undefined || value === null ? "" : String(value);
  });
}

/** Checks the raw payload or one scalar value parsed from its JSON body. */
function matchesPayloadFilter(filter: MqttRoute["payloadFilter"], payload: string): boolean {
  if (!filter) return true;
  if (filter.mode === "contains") return payload.includes(filter.value);
  if (filter.mode === "equals") return payload === filter.value;
  if (filter.mode !== "json-equals") return false;

  const parsed = parseRoutePayloadJson(payload);
  if (parsed === undefined) return false;
  const value = filter.path.split(".").reduce<unknown>((current, part) => {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, part)) return undefined;
    return (current as Record<string, unknown>)[part];
  }, parsed);
  if (typeof value === "string") return value === filter.value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value) === filter.value;
  return false;
}

/** Parses standard JSON and the single-quoted object syntax used by older panel events. */
function parseRoutePayloadJson(payload: string): unknown {
  try { return JSON.parse(payload); } catch { /* Try the panel's legacy single-quoted payload format. */ }
  const normalized = normalizeSingleQuotedJson(payload);
  if (normalized === undefined) return undefined;
  try { return JSON.parse(normalized); } catch { return undefined; }
}

/** Converts quoted strings in legacy panel objects into JSON without evaluating payload text. */
function normalizeSingleQuotedJson(payload: string): string | undefined {
  let normalized = "";
  for (let index = 0; index < payload.length;) {
    const character = payload[index];
    if (character === "\"") {
      const start = index++;
      let escaped = false;
      let closed = false;
      while (index < payload.length) {
        const current = payload[index++];
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === "\"") { closed = true; break; }
      }
      if (!closed) return undefined;
      normalized += payload.slice(start, index);
      continue;
    }
    if (character !== "'") {
      normalized += character;
      index++;
      continue;
    }

    index++;
    let value = "";
    let closed = false;
    while (index < payload.length) {
      const current = payload[index++];
      if (current === "'") { closed = true; break; }
      if (current !== "\\") { value += current; continue; }
      if (index >= payload.length) return undefined;
      const escaped = payload[index++];
      if (escaped === "'") value += "'";
      else if (escaped === "\"") value += "\"";
      else if (escaped === "\\") value += "\\";
      else if (escaped === "n") value += "\n";
      else if (escaped === "r") value += "\r";
      else if (escaped === "t") value += "\t";
      else if (escaped === "b") value += "\b";
      else if (escaped === "f") value += "\f";
      else if (escaped === "u") {
        const code = payload.slice(index, index + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(code)) return undefined;
        value += String.fromCharCode(Number.parseInt(code, 16));
        index += 4;
      } else value += `\\${escaped}`;
    }
    if (!closed) return undefined;
    normalized += JSON.stringify(value);
  }
  return normalized;
}
