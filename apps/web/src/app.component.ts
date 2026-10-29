import { Component, OnInit, signal, viewChild } from "@angular/core";
import { BrokerPageComponent } from "./app/features/broker/broker-page.component";
import { PanelPageComponent } from "./app/features/panels/panel-page.component";
import { RoutesPageComponent } from "./app/features/routes/routes-page.component";
import { PluginsPageComponent } from "./app/features/plugins/plugins-page.component";
import { ManagerStore } from "./app/manager-store.service";
import { AuthPageComponent } from "./app/features/auth/auth-page.component";
import { UsersPageComponent } from "./app/features/auth/users-page.component";
import { LogsPageComponent } from "./app/features/logs/logs-page.component";
import { BackupsPageComponent } from "./app/features/backups/backups-page.component";
import { HmiPageComponent } from "./app/features/hmi/hmi-page.component";
import { HelpPageComponent } from "./app/features/help/help-page.component";
import { TranslatePipe } from "@ngx-translate/core";
import { LocaleService } from "./app/i18n/locale.service";

type WorkspaceView = "panels" | "plugins" | "instances" | "routes" | "broker" | "users" | "logs" | "backups" | "hmi" | "help";

/**
 * Provides the persistent workspace shell and coordinates manager feature
 * pages while hiding the workspace until the API confirms a local
 * administrator session. The login view remains public so both local
 * password sign-in and optional SSO can establish that session.
 */
@Component({
  selector: "nspanel-app",
  standalone: true,
  imports: [AuthPageComponent, PanelPageComponent, PluginsPageComponent, RoutesPageComponent, BrokerPageComponent, UsersPageComponent, LogsPageComponent, BackupsPageComponent, HmiPageComponent, HelpPageComponent, TranslatePipe],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css"
})
export class AppComponent implements OnInit {
  readonly view = signal<WorkspaceView>("panels");
  readonly selectedPanelId = signal<string | null>(null);
  readonly theme = signal<"light" | "dark">("light");
  readonly settingsExpanded = signal(false);
  readonly panelPage = viewChild(PanelPageComponent);
  readonly pluginsPage = viewChild(PluginsPageComponent);
  readonly routesPage = viewChild(RoutesPageComponent);
  readonly brokerPage = viewChild(BrokerPageComponent);
  readonly usersPage = viewChild(UsersPageComponent);
  readonly logsPage = viewChild(LogsPageComponent);
  readonly hmiPage = viewChild(HmiPageComponent);
  readonly authLoaded = signal(false);
  readonly authError = signal(false);

  /** Receives shared manager state and restores the saved or system color theme. */
  constructor(readonly manager: ManagerStore, readonly locale: LocaleService) {
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

  /** Loads authentication state and opens the live API channel for signed-in administrators. */
  ngOnInit(): void {
    this.manager.loadAuthStatus().subscribe({
      next: () => { this.authLoaded.set(true); },
      error: () => { this.authLoaded.set(true); this.authError.set(true); }
    });
  }

  /** Changes the visible feature page and opens Settings when one of its pages is selected. */
  show(view: WorkspaceView): void {
    this.view.set(view);
    this.settingsExpanded.set(this.isSettingsView(view));
  }

  /** Expands or collapses the grouped settings navigation. */
  toggleSettings(): void { this.settingsExpanded.update((expanded) => !expanded); }

  /** Identifies views grouped under the Settings menu. */
  isSettingsView(view: WorkspaceView = this.view()): boolean {
    return view === "broker" || view === "users" || view === "logs" || view === "backups" || view === "hmi" || view === "help";
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
      case "plugins":
      case "instances": this.pluginsPage()?.refresh(); break;
      case "routes": this.routesPage()?.refresh(); break;
      case "broker": this.brokerPage()?.refresh(); break;
      case "users": this.usersPage()?.refresh(); break;
      case "logs": this.logsPage()?.refresh(); break;
      case "hmi": this.hmiPage()?.refresh(); break;
      case "help": break;
    }
  }

  /** Human-readable heading matching the selected workspace feature. */
  get pageTitle(): string {
    switch (this.view()) {
      case "panels": return "PAGE.PANELS";
      case "plugins": return "PAGE.PLUGINS";
      case "instances": return "PAGE.INSTANCES";
      case "routes": return "PAGE.ROUTES";
      case "users": return "PAGE.USERS";
      case "logs": return "PAGE.LOGS";
      case "backups": return "PAGE.BACKUPS";
      case "hmi": return "PAGE.UPDATES";
      case "help": return "PAGE.HELP";
      default: return "PAGE.BROKER";
    }
  }

  /** Breadcrumb label matching the selected workspace feature. */
  get viewLabel(): string {
    switch (this.view()) {
      case "panels": return "SECTION.PANELS";
      case "plugins":
      case "instances": return "SECTION.PLUGINS";
      case "routes": return "SECTION.AUTOMATIONS";
      case "users": return "SECTION.ACCESS";
      case "logs":
      case "backups":
      case "hmi":
      case "help": return "SECTION.SYSTEM";
      default: return "SECTION.SETUP";
    }
  }

  /** Revokes the current session and reveals the sign-in screen. */
  signOut(): void {
    this.manager.logout().subscribe({ error: () => this.manager.authUser.set(null) });
  }

  /** Applies a selected UI locale from the shell's accessible language picker. */
  changeLanguage(event: Event): void {
    if (event.target instanceof HTMLSelectElement) this.locale.useLanguage(event.target.value);
  }
}
