import { HttpClient } from "@angular/common/http";
import { Injectable, signal } from "@angular/core";
import { Observable, finalize, tap } from "rxjs";
import type { AuthStatus, AuthUser, BrokerInput, CoreDumpRecord, DiscoveredPanel, FirmwareArtifact, FirmwareRollout, FirmwareRolloutSettings, FirmwareUpdateJob, HmiUpdateJob, ManagerConfig, ManagerRealtimeEvent, ManagerState, MqttRoute, MqttStatus, Panel, PanelConnectionStatus, RouteDraft, PluginDefinition, PluginInstance, PluginInstanceDraft, PluginProfile, PluginProfileDraft, PanelBinding, PanelBindingDraft, PluginPagePreviewInput, PluginPagePreviewResult, PluginScriptCheckResult, AdminLogResult, LogLevel, HmiArtifact } from "./models";

type NoticeKind = "success" | "error";
export interface ManagerNotice { text: string; kind: NoticeKind }

/**
 * Owns the manager's shared remote state and typed HTTP boundary.
 *
 * Feature components call these methods instead of issuing requests directly,
 * which keeps API paths, optimistic configuration updates, and user feedback
 * consistent across panels, MQTT routes, and broker setup. The initial state
 * deliberately contains no broker URL or panels so the UI can render a useful
 * first-run state before the API responds.
 */
@Injectable({ providedIn: "root" })
export class ManagerStore {
  readonly config = signal<ManagerConfig>({
    broker: { url: "", username: "", passwordConfigured: false },
    firmwareRollout: { enabled: false, stableHours: 3 },
    panels: [],
    routes: [],
    pluginProfiles: [],
    pluginInstances: [],
    panelBindings: []
  });
  readonly mqtt = signal<MqttStatus>({ connected: false, error: "" });
  readonly panelConnections = signal<Record<string, PanelConnectionStatus>>({});
  readonly discoveredPanels = signal<DiscoveredPanel[]>([]);
  readonly hmiUpdateJobs = signal<HmiUpdateJob[]>([]);
  readonly firmwareUpdateJobs = signal<FirmwareUpdateJob[]>([]);
  readonly firmwareRollout = signal<FirmwareRollout | null>(null);
  readonly panelCoreDumps = signal<Record<string, CoreDumpRecord>>({});
  readonly realtimeConnected = signal(false);
  readonly notice = signal<ManagerNotice | null>(null);
  readonly authStatus = signal<AuthStatus | null>(null);
  readonly authUser = signal<AuthUser | null>(null);
  private realtimeSocket?: WebSocket;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectDelayMs = 1000;
  private realtimeGeneration = 0;

  /** Creates the shared state boundary for all feature components. */
  constructor(private readonly http: HttpClient) {}

  /** Loads the public login state and current account without exposing user credentials. */
  loadAuthStatus(): Observable<AuthStatus> {
    return this.http.get<AuthStatus>("/api/auth/status").pipe(tap((status) => {
      this.authStatus.set(status);
      this.authUser.set(status.user ?? null);
      if (status.authenticated) this.connectRealtime();
      else this.disconnectRealtime();
    }));
  }

  /** Signs in with a local email/password account and stores its safe display record. */
  login(email: string, password: string): Observable<{ user: AuthUser }> {
    return this.http.post<{ user: AuthUser }>("/api/auth/login", { email, password }).pipe(tap(({ user }) => {
      this.authUser.set(user);
      this.connectRealtime();
    }));
  }

  /** Requests a PKCE-protected OIDC authorization URL before navigating to the provider. */
  startSsoLogin(): Observable<{ authorizationUrl: string }> {
    return this.http.post<{ authorizationUrl: string }>("/api/auth/sso/start", {});
  }

  /**
   * Creates the first administrator using the API startup token and marks the onboarding browser as signed in.
   * The token is sent only in the setup request body and is never added to manager state.
   */
  setupFirstUser(email: string, password: string, bootstrapToken: string): Observable<{ user: AuthUser }> {
    return this.http.post<{ user: AuthUser }>("/api/auth/setup", { email, password, bootstrapToken }).pipe(tap(({ user }) => {
      this.authUser.set(user);
      this.authStatus.update((status) => ({ authenticated: true, user, hasUsers: true, ssoEnabled: status?.ssoEnabled ?? false }));
      this.connectRealtime();
    }));
  }

  /** Signs out and clears the browser's authenticated manager state. */
  logout(): Observable<void> {
    return this.http.post<void>("/api/auth/logout", {}).pipe(finalize(() => {
      this.authUser.set(null);
      this.authStatus.update((status) => status ? { ...status, authenticated: false, user: undefined } : status);
      this.disconnectRealtime();
    }));
  }

  /** Fetches local administrator accounts without password hashes. */
  loadUsers(): Observable<{ users: AuthUser[] }> { return this.http.get<{ users: AuthUser[] }>("/api/auth/users"); }

  /** Adds an existing-user account to the local allowlist. */
  createUser(email: string, password: string): Observable<{ user: AuthUser }> {
    return this.http.post<{ user: AuthUser }>("/api/auth/users", { email, password });
  }

  /** Enables, disables, or resets the password for one local account. */
  updateUser(id: string, update: { password?: string; enabled?: boolean }): Observable<{ user: AuthUser }> {
    return this.http.put<{ user: AuthUser }>(`/api/auth/users/${id}`, update);
  }

  /** Removes a local account and revokes its active sessions. */
  removeUser(id: string): Observable<void> { return this.http.delete<void>(`/api/auth/users/${id}`); }

  /**
   * Fetches persisted manager configuration and its current broker status.
   *
   * Use this for initial loading and explicit refresh actions. Broker polling
   * uses `refreshHealth()` so unsaved panel edits are not replaced.
   */
  refresh(): Observable<ManagerState> {
    return this.http.get<ManagerState>("/api/state").pipe(tap((state) => this.acceptState(state)));
  }

  /** Updates the lightweight connection indicator without reloading drafts. */
  refreshHealth(): Observable<{ mqtt: MqttStatus }> {
    return this.http.get<{ mqtt: MqttStatus }>("/api/health").pipe(tap((health) => this.mqtt.set(health.mqtt)));
  }

  /** Refreshes live panel connectivity independently from editable configuration drafts. */
  refreshPanelConnections(): Observable<{ panels: PanelConnectionStatus[] }> {
    return this.http.get<{ panels: PanelConnectionStatus[] }>("/api/panels/status").pipe(tap(({ panels }) => {
      this.panelConnections.set(Object.fromEntries(panels.map((panel) => [panel.nodeName, panel])));
    }));
  }

  /** Loads the latest uploaded HMI artifact and the API upload limit. */
  loadHmiArtifact(): Observable<{ artifact: HmiArtifact | null; maxUploadBytes: number }> {
    return this.http.get<{ artifact: HmiArtifact | null; maxUploadBytes: number }>("/api/hmi");
  }

  /** Uploads the selected `.tft` file as a binary request body. */
  uploadHmi(file: File): Observable<{ artifact: HmiArtifact }> {
    return this.http.post<{ artifact: HmiArtifact }>("/api/hmi/upload", file, {
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Hmi-Filename": encodeURIComponent(file.name)
      }
    });
  }

  /** Sends an HMI update request, optionally bypassing the panel's confirmation screen. */
  requestHmiUpdate(panelId: string, force = false): Observable<{ published: boolean; panel: { id: string; name: string }; topic: string; expiresAt: string; hmiVersion: string; job: HmiUpdateJob }> {
    return this.http.post<{ published: boolean; panel: { id: string; name: string }; topic: string; expiresAt: string; hmiVersion: string; job: HmiUpdateJob }>(`/api/hmi/panels/${panelId}/update`, { force }).pipe(tap(({ job }) => this.upsertHmiUpdateJob(job)));
  }

  /** Loads the latest stored ESPHome OTA binary metadata and upload limit. */
  loadFirmwareArtifact(): Observable<{ artifact: FirmwareArtifact | null; maxUploadBytes: number }> {
    return this.http.get<{ artifact: FirmwareArtifact | null; maxUploadBytes: number }>("/api/firmware");
  }

  /** Uploads a versioned firmware package whose manifest supplies the compiled version. */
  uploadFirmware(file: File): Observable<{ artifact: FirmwareArtifact }> {
    return this.http.post<{ artifact: FirmwareArtifact }>("/api/firmware/upload", file, {
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Firmware-Filename": encodeURIComponent(file.name)
      }
    });
  }

  /** Sends the current firmware binary to one panel, optionally bypassing confirmation. */
  requestFirmwareUpdate(panelId: string, force = false): Observable<{ published: boolean; panel: { id: string; name: string }; topic: string; expiresAt: string; firmwareVersion: string; job: FirmwareUpdateJob }> {
    return this.http.post<{ published: boolean; panel: { id: string; name: string }; topic: string; expiresAt: string; firmwareVersion: string; job: FirmwareUpdateJob }>(`/api/firmware/panels/${panelId}/update`, { force }).pipe(tap(({ job }) => this.upsertFirmwareUpdateJob(job)));
  }

  /** Starts canary monitoring from a panel that already reports the uploaded firmware version. */
  stageFirmwareRollout(panelId: string): Observable<{ rollout: FirmwareRollout }> {
    return this.http.post<{ rollout: FirmwareRollout }>(`/api/firmware/panels/${encodeURIComponent(panelId)}/stage-rollout`, {}).pipe(tap(({ rollout }) => {
      this.firmwareRollout.set(rollout);
    }));
  }

  /** Saves the global canary stability window for future staged firmware rollouts. */
  saveFirmwareRolloutSettings(settings: FirmwareRolloutSettings): Observable<{ firmwareRollout: FirmwareRolloutSettings }> {
    return this.http.put<{ firmwareRollout: FirmwareRolloutSettings }>("/api/firmware/rollout-settings", settings).pipe(tap(({ firmwareRollout }) => {
      this.config.update((config) => ({ ...config, firmwareRollout }));
    }));
  }

  /** Adds or removes one unified panel from future automatic firmware rollouts. */
  setPanelAutoUpdateFirmware(panelId: string, enabled: boolean): Observable<{ panel: Panel }> {
    return this.http.patch<{ panel: Panel }>(`/api/panels/${panelId}/firmware-rollout`, { autoUpdateFirmware: enabled }).pipe(tap(({ panel }) => {
      this.config.update((config) => ({ ...config, panels: config.panels.map((item) => item.id === panel.id ? panel : item) }));
    }));
  }

  /** Loads the most recent crash dump metadata for one configured panel. */
  loadPanelCoreDump(panelId: string): Observable<{ dump: CoreDumpRecord | null }> {
    return this.http.get<{ dump: CoreDumpRecord | null }>(`/api/firmware/panels/${encodeURIComponent(panelId)}/crash-dump`).pipe(tap(({ dump }) => {
      this.panelCoreDumps.update((current) => {
        if (!dump) {
          const next = { ...current };
          delete next[panelId];
          return next;
        }
        return { ...current, [panelId]: dump };
      });
    }));
  }

  /** Downloads the manager's retained ESP-IDF core dump for one panel. */
  downloadPanelCoreDump(panelId: string): Observable<Blob> {
    return this.http.get(`/api/firmware/panels/${encodeURIComponent(panelId)}/crash-dump/download`, { responseType: "blob" });
  }

  /** Opens the authenticated same-origin realtime channel and retries transient disconnects. */
  connectRealtime(): void {
    if (typeof window === "undefined" || !this.authUser() || this.realtimeSocket || this.reconnectTimer) return;
    const generation = this.realtimeGeneration;
    const url = new URL("/api/events", window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    this.realtimeSocket = socket;
    socket.onopen = () => {
      if (generation !== this.realtimeGeneration || this.realtimeSocket !== socket) return;
      this.realtimeConnected.set(true);
      this.reconnectDelayMs = 1000;
    };
    socket.onmessage = (event) => {
      if (generation !== this.realtimeGeneration) return;
      try { this.acceptRealtimeEvent(JSON.parse(String(event.data)) as unknown); } catch { /* Ignore malformed or unsupported API frames. */ }
    };
    socket.onclose = (event) => {
      if (generation !== this.realtimeGeneration || this.realtimeSocket !== socket) return;
      this.realtimeSocket = undefined;
      this.realtimeConnected.set(false);
      if (event.code === 4401) {
        this.authUser.set(null);
        this.authStatus.update((status) => status ? { ...status, authenticated: false, user: undefined } : status);
        return;
      }
      this.scheduleRealtimeReconnect();
    };
  }

  /** Closes the live channel and cancels pending reconnects when the browser signs out. */
  disconnectRealtime(): void {
    this.realtimeGeneration += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const socket = this.realtimeSocket;
    this.realtimeSocket = undefined;
    this.realtimeConnected.set(false);
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "Signed out.");
  }

  private scheduleRealtimeReconnect(): void {
    if (!this.authUser() || this.reconnectTimer || typeof window === "undefined") return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connectRealtime();
    }, delay);
  }

  private acceptRealtimeEvent(value: unknown): void {
    if (!isRecord(value) || typeof value["type"] !== "string") return;
    const event = value as unknown as ManagerRealtimeEvent;
    if (event.type === "snapshot") {
      this.setPanelConnections(event.panels);
      this.discoveredPanels.set(Array.isArray(event.discoveredPanels) ? event.discoveredPanels : []);
      this.mergeHmiUpdateJobs(event.hmiJobs);
      this.mergeFirmwareUpdateJobs(event.firmwareJobs);
      this.firmwareRollout.set(event.firmwareRollout ?? null);
      this.mqtt.set(event.mqtt);
    } else if (event.type === "panels") {
      this.setPanelConnections(event.panels);
    } else if (event.type === "discovered-panels") {
      this.discoveredPanels.set(Array.isArray(event.panels) ? event.panels : []);
    } else if (event.type === "hmi-job") {
      this.upsertHmiUpdateJob(event.job);
    } else if (event.type === "firmware-job") {
      this.upsertFirmwareUpdateJob(event.job);
    } else if (event.type === "firmware-rollout") {
      this.firmwareRollout.set(event.rollout);
    } else if (event.type === "core-dump") {
      this.panelCoreDumps.update((dumps) => ({ ...dumps, [event.dump.panelId]: event.dump }));
    } else if (event.type === "mqtt") {
      this.mqtt.set(event.mqtt);
    }
  }

  private setPanelConnections(panels: PanelConnectionStatus[]): void {
    if (!Array.isArray(panels)) return;
    this.panelConnections.set(Object.fromEntries(panels.map((panel) => [panel.nodeName, panel])));
  }

  private upsertHmiUpdateJob(job: HmiUpdateJob): void {
    this.hmiUpdateJobs.update((jobs) => {
      const current = jobs.find((item) => item.id === job.id);
      if (current && current.updatedAt > job.updatedAt) return jobs;
      return [job, ...jobs.filter((item) => item.id !== job.id)].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 200);
    });
  }

  private mergeHmiUpdateJobs(incoming: HmiUpdateJob[]): void {
    this.hmiUpdateJobs.update((current) => {
      const jobs = new Map(current.map((job) => [job.id, job]));
      for (const job of incoming) {
        const existing = jobs.get(job.id);
        if (!existing || job.updatedAt >= existing.updatedAt) jobs.set(job.id, job);
      }
      return [...jobs.values()].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 200);
    });
  }

  private upsertFirmwareUpdateJob(job: FirmwareUpdateJob): void {
    this.firmwareUpdateJobs.update((jobs) => {
      const current = jobs.find((item) => item.id === job.id);
      if (current && current.updatedAt > job.updatedAt) return jobs;
      return [job, ...jobs.filter((item) => item.id !== job.id)].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 200);
    });
  }

  private mergeFirmwareUpdateJobs(incoming: FirmwareUpdateJob[]): void {
    this.firmwareUpdateJobs.update((current) => {
      const jobs = new Map(current.map((job) => [job.id, job]));
      for (const job of incoming) {
        const existing = jobs.get(job.id);
        if (!existing || job.updatedAt >= existing.updatedAt) jobs.set(job.id, job);
      }
      return [...jobs.values()].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 200);
    });
  }

  /** Reads a bounded, optionally filtered set of recent records from rotated manager log files. */
  loadLogs(filters: { limit?: number; offset?: number; category?: string; level?: LogLevel } = {}): Observable<AdminLogResult> {
    const query = new URLSearchParams({ limit: String(filters.limit ?? 200), offset: String(filters.offset ?? 0) });
    if (filters.category) query.set("category", filters.category);
    if (filters.level) query.set("level", filters.level);
    return this.http.get<AdminLogResult>(`/api/logs?${query.toString()}`);
  }

  /** Saves broker settings and refreshes the public configuration returned by the API. */
  saveBroker(input: BrokerInput): Observable<ManagerState> {
    return this.http.put<ManagerState>("/api/broker", input).pipe(tap((state) => this.acceptState(state)));
  }

  /** Adds a panel profile using its human label and firmware MQTT node name. */
  addPanel(input: { name: string; nodeName: string; macAddress?: string }): Observable<{ panel: Panel }> {
    return this.http.post<{ panel: Panel }>("/api/panels", input).pipe(tap(({ panel }) => {
      this.config.update((config) => ({ ...config, panels: [...config.panels, panel] }));
    }));
  }

  /** Requests an immediate ESPHome MQTT discovery response from connected devices. */
  requestPanelDiscovery(): Observable<{ requested: boolean }> {
    return this.http.post<{ requested: boolean }>("/api/panels/discover", {});
  }

  /** Assigns or clears a discovered device MAC on a saved panel profile. */
  setPanelMacAddress(panelId: string, macAddress: string | null): Observable<{ panel: Panel }> {
    return this.http.patch<{ panel: Panel }>(`/api/panels/${panelId}/identity`, { macAddress }).pipe(tap(({ panel }) => {
      this.config.update((config) => ({ ...config, panels: config.panels.map((item) => item.id === panel.id ? panel : item) }));
    }));
  }

  /** Persists the selected panel profile and its firmware-compatible settings JSON. */
  savePanel(panel: Panel): Observable<{ panel: Panel; published: boolean; topic: string }> {
    return this.http.put<{ panel: Panel; published: boolean; topic: string }>(`/api/panels/${panel.id}`, panel).pipe(tap(({ panel: saved }) => {
      this.config.update((config) => ({ ...config, panels: config.panels.map((item) => item.id === saved.id ? saved : item) }));
    }));
  }

  /** Copies one saved panel's settings and favorite bindings onto another panel profile. */
  copyPanelSettings(sourcePanelId: string, targetPanelId: string): Observable<{ panel: Panel; panelBindings: PanelBinding[]; published: boolean; topic: string }> {
    return this.http.post<{ panel: Panel; panelBindings: PanelBinding[]; published: boolean; topic: string }>(
      "/api/panels/" + targetPanelId + "/copy-settings",
      { sourcePanelId }
    ).pipe(tap(({ panel, panelBindings }) => {
      this.config.update((config) => ({
        ...config,
        panels: config.panels.map((item) => item.id === panel.id ? panel : item),
        panelBindings: [
          ...config.panelBindings.filter((binding) => binding.panelId !== panel.id),
          ...panelBindings
        ]
      }));
    }));
  }

  /** Publishes one saved profile to `<nodeName>/cmnd/settings`. */
  applyPanel(panel: Panel): Observable<{ published: boolean; topic: string }> {
    return this.http.post<{ published: boolean; topic: string }>(`/api/panels/${panel.id}/apply`, {});
  }

  /** Removes a panel and lets the API remove routes tied to that profile. */
  removePanel(panel: Panel): Observable<void> {
    return this.http.delete<void>(`/api/panels/${panel.id}`).pipe(tap(() => {
      this.config.update((config) => ({
        ...config,
        panels: config.panels.filter((item) => item.id !== panel.id),
        routes: config.routes.filter((route) => route.panelId !== panel.id),
        panelBindings: config.panelBindings.filter((binding) => binding.panelId !== panel.id)
      }));
    }));
  }

  /** Registers a topic mapping and appends the saved server record to shared state. */
  addRoute(draft: RouteDraft): Observable<{ route: MqttRoute }> {
    return this.http.post<{ route: MqttRoute }>("/api/routes", draft).pipe(tap(({ route }) => {
      this.config.update((config) => ({ ...config, routes: [...config.routes, route] }));
    }));
  }

  /** Saves edited route settings and replaces the matching shared route record. */
  updateRoute(id: string, draft: RouteDraft): Observable<{ route: MqttRoute }> {
    return this.http.put<{ route: MqttRoute }>(`/api/routes/${id}`, draft).pipe(tap(({ route }) => {
      this.config.update((config) => ({ ...config, routes: config.routes.map((item) => item.id === route.id ? route : item) }));
    }));
  }

  /** Deletes a topic mapping from persistent storage and local shared state. */
  removeRoute(route: MqttRoute): Observable<void> {
    return this.http.delete<void>(`/api/routes/${route.id}`).pipe(tap(() => {
      this.config.update((config) => ({ ...config, routes: config.routes.filter((item) => item.id !== route.id) }));
    }));
  }

  /** Fetches registered plugin schemas for the feature-driven setup form. */
  loadPlugins(): Observable<{ plugins: PluginDefinition[] }> {
    return this.http.get<{ plugins: PluginDefinition[] }>("/api/plugins");
  }

  /** Renders a page or simulates its button action with disposable MQTT and storage effects. */
  previewPluginPage(input: PluginPagePreviewInput): Observable<PluginPagePreviewResult> {
    return this.http.post<PluginPagePreviewResult>("/api/plugins/preview", input);
  }

  /** Checks configured JavaScript syntax without executing the function body. */
  checkPluginScript(source: string, variables: Record<string, string> = {}): Observable<PluginScriptCheckResult> {
    return this.http.post<PluginScriptCheckResult>("/api/plugins/check-script", { source, variables });
  }

  /** Creates a reusable plugin configuration that instances can share. */
  addPluginProfile(draft: PluginProfileDraft): Observable<{ profile: PluginProfile }> {
    return this.http.post<{ profile: PluginProfile }>("/api/plugins/profiles", draft).pipe(tap(({ profile }) => {
      this.config.update((config) => ({ ...config, pluginProfiles: [...config.pluginProfiles, profile] }));
    }));
  }

  /** Saves changes to one reusable plugin without copying them to instances. */
  savePluginProfile(profile: PluginProfile): Observable<{ profile: PluginProfile }> {
    return this.http.put<{ profile: PluginProfile }>(`/api/plugins/profiles/${profile.id}`, profile).pipe(tap(({ profile: saved }) => {
      this.config.update((config) => ({ ...config, pluginProfiles: config.pluginProfiles.map((item) => item.id === saved.id ? saved : item) }));
    }));
  }

  /** Removes a reusable plugin after its instances have been removed or reassigned. */
  removePluginProfile(profile: PluginProfile): Observable<void> {
    return this.http.delete<void>(`/api/plugins/profiles/${profile.id}`).pipe(tap(() => {
      this.config.update((config) => ({ ...config, pluginProfiles: config.pluginProfiles.filter((item) => item.id !== profile.id) }));
    }));
  }

  /** Creates a configured instance of a registered plugin implementation. */
  addPluginInstance(draft: PluginInstanceDraft): Observable<{ instance: PluginInstance }> {
    return this.http.post<{ instance: PluginInstance }>("/api/plugins/instances", draft).pipe(tap(({ instance }) => {
      this.config.update((config) => ({ ...config, pluginInstances: [...config.pluginInstances, instance] }));
    }));
  }

  /** Saves editable plugin settings while retaining its stable instance identifier. */
  savePluginInstance(instance: PluginInstance): Observable<{ instance: PluginInstance }> {
    return this.http.put<{ instance: PluginInstance }>(`/api/plugins/instances/${instance.id}`, instance).pipe(tap(({ instance: saved }) => {
      this.config.update((config) => ({ ...config, pluginInstances: config.pluginInstances.map((item) => item.id === saved.id ? saved : item) }));
    }));
  }

  /** Removes a plugin instance, its favorite bindings, and its panel event-observer assignments. */
  removePluginInstance(instance: PluginInstance): Observable<void> {
    return this.http.delete<void>(`/api/plugins/instances/${instance.id}`).pipe(tap(() => {
      this.config.update((config) => ({
        ...config,
        pluginInstances: config.pluginInstances.filter((item) => item.id !== instance.id),
        panelBindings: config.panelBindings.filter((item) => item.pluginInstanceId !== instance.id),
        panels: config.panels.map((panel) => ({
          ...panel,
          panelEventPluginInstances: Object.fromEntries(Object.entries(panel.panelEventPluginInstances ?? {}).filter(([, assignedInstanceId]) => assignedInstanceId !== instance.id))
        }))
      }));
    }));
  }

  /** Binds a plugin instance to a favorite slot and saves that shortcut label. */
  addPanelBinding(draft: PanelBindingDraft): Observable<{ binding: PanelBinding }> {
    return this.http.post<{ binding: PanelBinding }>("/api/plugins/bindings", draft).pipe(tap(({ binding }) => {
      this.config.update((config) => ({
        ...config,
        panelBindings: [...config.panelBindings, binding],
        panels: config.panels.map((panel) => panel.id === binding.panelId ? {
          ...panel,
          settings: {
            ...panel.settings,
            favorites: {
              ...panel.settings.favorites,
              buttons: panel.settings.favorites.buttons.map((favorite, index) => index === binding.trigger.index ? { ...favorite, label: binding.name, mode: 0 } : favorite)
            }
          }
        } : panel)
      }));
    }));
  }

  /** Removes a favorite binding from persistent config and its local projection. */
  removePanelBinding(binding: PanelBinding): Observable<void> {
    return this.http.delete<void>(`/api/plugins/bindings/${binding.id}`).pipe(tap(() => {
      this.config.update((config) => ({
        ...config,
        panelBindings: config.panelBindings.filter((item) => item.id !== binding.id),
        panels: config.panels.map((panel) => panel.id === binding.panelId ? {
          ...panel,
          settings: {
            ...panel.settings,
            favorites: {
              ...panel.settings.favorites,
              buttons: panel.settings.favorites.buttons.map((favorite, index) => index === binding.trigger.index && favorite.label === binding.name ? { ...favorite, label: "" } : favorite)
            }
          }
        } : panel)
      }));
    }));
  }

  /** Records a short-lived success or error message for the app shell. */
  inform(text: string, kind: NoticeKind = "success"): void { this.notice.set({ text, kind }); }

  /** Clears the current message after the user dismisses it. */
  dismissNotice(): void { this.notice.set(null); }

  private acceptState(state: ManagerState): void {
    this.config.set(state.config);
    this.mqtt.set(state.mqtt);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
