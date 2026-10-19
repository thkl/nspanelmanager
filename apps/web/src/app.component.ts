import { Component, OnDestroy, OnInit, signal, viewChild } from "@angular/core";
import { BrokerPageComponent } from "./app/features/broker/broker-page.component";
import { PanelPageComponent } from "./app/features/panels/panel-page.component";
import { RoutesPageComponent } from "./app/features/routes/routes-page.component";
import { PluginsPageComponent } from "./app/features/plugins/plugins-page.component";
import { ManagerStore } from "./app/manager-store.service";
import { AuthPageComponent } from "./app/features/auth/auth-page.component";
import { UsersPageComponent } from "./app/features/auth/users-page.component";

type WorkspaceView = "panels" | "plugins" | "routes" | "broker" | "users";

/**
 * Provides the persistent workspace shell and coordinates the three manager
 * feature pages and hides the management workspace until the API confirms a
 * local administrator session. The login view remains public so both local
 * password sign-in and optional SSO can establish that session.
 */
@Component({
  selector: "nspanel-app",
  standalone: true,
  imports: [AuthPageComponent, PanelPageComponent, PluginsPageComponent, RoutesPageComponent, BrokerPageComponent, UsersPageComponent],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css"
})
export class AppComponent implements OnInit, OnDestroy {
  readonly view = signal<WorkspaceView>("panels");
  readonly panelPage = viewChild(PanelPageComponent);
  readonly pluginsPage = viewChild(PluginsPageComponent);
  readonly routesPage = viewChild(RoutesPageComponent);
  readonly brokerPage = viewChild(BrokerPageComponent);
  readonly usersPage = viewChild(UsersPageComponent);
  readonly authLoaded = signal(false);
  readonly authError = signal(false);
  private healthTimer?: ReturnType<typeof setInterval>;

  /** Receives shared manager state and starts the API connection poll. */
  constructor(readonly manager: ManagerStore) {}

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

  /** Changes the visible feature page using the typed navigation state. */
  show(view: WorkspaceView): void { this.view.set(view); }

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
    }
  }

  /** Human-readable heading matching the selected workspace feature. */
  get pageTitle(): string {
    return this.view() === "panels" ? "Panel manager" : this.view() === "plugins" ? "Plugin manager" : this.view() === "routes" ? "MQTT routes" : this.view() === "users" ? "User accounts" : "Broker connection";
  }

  /** Breadcrumb label matching the selected workspace feature. */
  get viewLabel(): string {
    return this.view() === "panels" ? "PANELS" : this.view() === "plugins" ? "PLUGINS" : this.view() === "routes" ? "AUTOMATIONS" : this.view() === "users" ? "ACCESS" : "SETUP";
  }

  /** Revokes the current session and reveals the sign-in screen. */
  signOut(): void {
    this.manager.logout().subscribe({ error: () => this.manager.authUser.set(null) });
  }
}
