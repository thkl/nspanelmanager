import { HttpClient } from "@angular/common/http";
import { Injectable, signal } from "@angular/core";
import { Observable, tap } from "rxjs";
import type { AuthStatus, AuthUser, BrokerInput, ManagerConfig, ManagerState, MqttRoute, MqttStatus, Panel, RouteDraft, PluginDefinition, PluginInstance, PluginInstanceDraft, PluginProfile, PluginProfileDraft, PanelBinding, PanelBindingDraft, PluginPagePreviewInput, PluginPagePreviewResult, PluginScriptCheckResult } from "./models";

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
    panels: [],
    routes: [],
    pluginProfiles: [],
    pluginInstances: [],
    panelBindings: []
  });
  readonly mqtt = signal<MqttStatus>({ connected: false, error: "" });
  readonly notice = signal<ManagerNotice | null>(null);
  readonly authStatus = signal<AuthStatus | null>(null);
  readonly authUser = signal<AuthUser | null>(null);

  /** Creates the shared state boundary for all feature components. */
  constructor(private readonly http: HttpClient) {}

  /** Loads the public login state and current account without exposing user credentials. */
  loadAuthStatus(): Observable<AuthStatus> {
    return this.http.get<AuthStatus>("/api/auth/status").pipe(tap((status) => {
      this.authStatus.set(status);
      this.authUser.set(status.user ?? null);
    }));
  }

  /** Signs in with a local email/password account and stores its safe display record. */
  login(email: string, password: string): Observable<{ user: AuthUser }> {
    return this.http.post<{ user: AuthUser }>("/api/auth/login", { email, password }).pipe(tap(({ user }) => this.authUser.set(user)));
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
    }));
  }

  /** Signs out and clears the browser's authenticated manager state. */
  logout(): Observable<void> {
    return this.http.post<void>("/api/auth/logout", {}).pipe(tap(() => this.authUser.set(null)));
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

  /** Saves broker settings and refreshes the public configuration returned by the API. */
  saveBroker(input: BrokerInput): Observable<ManagerState> {
    return this.http.put<ManagerState>("/api/broker", input).pipe(tap((state) => this.acceptState(state)));
  }

  /** Adds a panel profile using its human label and firmware MQTT node name. */
  addPanel(input: { name: string; nodeName: string }): Observable<{ panel: Panel }> {
    return this.http.post<{ panel: Panel }>("/api/panels", input).pipe(tap(({ panel }) => {
      this.config.update((config) => ({ ...config, panels: [...config.panels, panel] }));
    }));
  }

  /** Persists the selected panel profile and its firmware-compatible settings JSON. */
  savePanel(panel: Panel): Observable<{ panel: Panel }> {
    return this.http.put<{ panel: Panel }>(`/api/panels/${panel.id}`, panel).pipe(tap(({ panel: saved }) => {
      this.config.update((config) => ({ ...config, panels: config.panels.map((item) => item.id === saved.id ? saved : item) }));
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

  /** Renders an unsaved plugin page against sample MQTT input without publishing or persisting effects. */
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

  /** Removes a plugin instance and the favorite bindings managed by the API. */
  removePluginInstance(instance: PluginInstance): Observable<void> {
    return this.http.delete<void>(`/api/plugins/instances/${instance.id}`).pipe(tap(() => {
      this.config.update((config) => ({
        ...config,
        pluginInstances: config.pluginInstances.filter((item) => item.id !== instance.id),
        panelBindings: config.panelBindings.filter((item) => item.pluginInstanceId !== instance.id)
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
