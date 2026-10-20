import { Component, OnDestroy, OnInit, signal, viewChild } from "@angular/core";
import { BrokerPageComponent } from "./app/features/broker/broker-page.component";
import { PanelPageComponent } from "./app/features/panels/panel-page.component";
import { RoutesPageComponent } from "./app/features/routes/routes-page.component";
import { PluginsPageComponent } from "./app/features/plugins/plugins-page.component";
import { ManagerStore } from "./app/manager-store.service";
import { AuthPageComponent } from "./app/features/auth/auth-page.component";
import { UsersPageComponent } from "./app/features/auth/users-page.component";
import { LogsPageComponent } from "./app/features/logs/logs-page.component";
import { BackupsPageComponent } from "./app/features/backups/backups-page.component";

type WorkspaceView = "panels" | "plugins" | "routes" | "broker" | "users" | "logs" | "backups";

/**
 * Provides the persistent workspace shell and coordinates manager feature
 * pages while hiding the workspace until the API confirms a local
 * administrator session. The login view remains public so both local
 * password sign-in and optional SSO can establish that session.
 */
@Component({
  selector: "nspanel-app",
  standalone: true,
  imports: [AuthPageComponent, PanelPageComponent, PluginsPageComponent, RoutesPageComponent, BrokerPageComponent, UsersPageComponent, LogsPageComponent, BackupsPageComponent],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css"
})
export class AppComponent implements OnInit, OnDestroy {
  readonly view = signal<WorkspaceView>("panels");
  readonly theme = signal<"light" | "dark">("light");
  readonly settingsExpanded = signal(false);
  readonly panelPage = viewChild(PanelPageComponent);
  readonly pluginsPage = viewChild(PluginsPageComponent);
  readonly routesPage = viewChild(RoutesPageComponent);
  readonly brokerPage = viewChild(BrokerPageComponent);
  readonly usersPage = viewChild(UsersPageComponent);
  readonly logsPage = viewChild(LogsPageComponent);
  readonly authLoaded = signal(false);
  readonly authError = signal(false);
  private healthTimer?: ReturnType<typeof setInterval>;

  /** Receives shared manager state and restores the saved or system color theme. */
  constructor(readonly manager: ManagerStore) {
    let theme: "light" | "dark" = "light";
    if (typeof window !== "undefined") {
      try {
        const saved = window.localStorage.getItem("nspanel-manager-theme");
        theme = saved === "light" || saved === "dark"
          ? saved
          : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      } catch {
        theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      }
    }
    this.setTheme(theme, false);
  }

  /** Switches between light and dark palettes and remembers the user's choice. */
  toggleTheme(): void {
    this.setTheme(this.theme() === "dark" ? "light" : "dark", true);
  }

  /** Applies a theme to the document and optionally persists an explicit choice. */
  private setTheme(theme: "light" | "dark", persist: boolean): void {
    this.theme.set(theme);
    if (typeof document === "undefined") return;
    document.documentElement.dataset["theme"] = theme;
    const canvasColor = document.defaultView?.getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim();
    if (canvasColor) document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", canvasColor);
    if (!persist || typeof window === "undefined") return;
    try { window.localStorage.setItem("nspanel-manager-theme", theme); } catch { /* Theme remains active for this page view. */ }
  }

  /** Loads authentication state before revealing manager controls and polls status while signed in. */
  ngOnInit(): void {
    this.manager.loadAuthStatus().subscribe({
      next: () => { this.authLoaded.set(true); },
      error: () => { this.authLoaded.set(true); this.authError.set(true); }
    });
    this.healthTimer = setInterval(() => {
      if (!this.manager.authUser()) return;
      this.manager.loadAuthStatus().subscribe({
        next: () => this.manager.refreshHealth().subscribe({ error: () => this.manager.inform("Manager API is unavailable.", "error") }),
        error: () => this.manager.authUser.set(null)
      });
    }, 15000);
  }

  /** Stops the browser timer when the workspace shell is destroyed. */
  ngOnDestroy(): void { if (this.healthTimer) clearInterval(this.healthTimer); }

  /** Changes the visible feature page and opens Settings when one of its pages is selected. */
  show(view: WorkspaceView): void {
    this.view.set(view);
    this.settingsExpanded.set(this.isSettingsView(view));
  }

  /** Expands or collapses the grouped settings navigation. */
  toggleSettings(): void { this.settingsExpanded.update((expanded) => !expanded); }

  /** Identifies views grouped under the Settings menu. */
  isSettingsView(view: WorkspaceView = this.view()): boolean {
    return view === "broker" || view === "users" || view === "logs" || view === "backups";
  }

  /**
   * Refreshes the active feature without touching unrelated in-progress edits.
   *
   * The signal-based `viewChild()` queries follow pages created by `@if` and
   * naturally return `undefined` when their page is not currently rendered.
   */
  refreshCurrent(): void {
    switch (this.view()) {
      case "panels": this.panelPage()?.refresh(); break;
      case "plugins": this.pluginsPage()?.refresh(); break;
      case "routes": this.routesPage()?.refresh(); break;
      case "broker": this.brokerPage()?.refresh(); break;
      case "users": this.usersPage()?.refresh(); break;
      case "logs": this.logsPage()?.refresh(); break;
    }
  }

  /** Human-readable heading matching the selected workspace feature. */
  get pageTitle(): string {
    return this.view() === "panels" ? "Panel manager" : this.view() === "plugins" ? "Plugin manager" : this.view() === "routes" ? "MQTT routes" : this.view() === "users" ? "User accounts" : this.view() === "logs" ? "Application logs" : this.view() === "backups" ? "Data backup" : "Broker connection";
  }

  /** Breadcrumb label matching the selected workspace feature. */
  get viewLabel(): string {
    return this.view() === "panels" ? "PANELS" : this.view() === "plugins" ? "PLUGINS" : this.view() === "routes" ? "AUTOMATIONS" : this.view() === "users" ? "ACCESS" : this.view() === "logs" || this.view() === "backups" ? "SYSTEM" : "SETUP";
  }

  /** Revokes the current session and reveals the sign-in screen. */
  signOut(): void {
    this.manager.logout().subscribe({ error: () => this.manager.authUser.set(null) });
  }
}
