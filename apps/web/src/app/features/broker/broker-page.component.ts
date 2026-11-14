import { Component, OnInit, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { TranslatePipe } from "@ngx-translate/core";
import { ManagerStore } from "../../manager-store.service";
import type { BrokerInput, HttpLogTransportInput } from "../../models";

/**
 * Configures the single MQTT connection shared by all panel profiles and routes.
 *
 * Broker credentials are sent only when saved. The API never returns the stored
 * password; leaving the password field blank preserves its existing value.
 */
@Component({
  selector: "nspanel-broker-page",
  standalone: true,
  imports: [FormsModule, TranslatePipe],
  templateUrl: "./broker-page.component.html",
  styleUrl: "./broker-page.component.css"
})
export class BrokerPageComponent implements OnInit {
  readonly draft = signal<BrokerInput>({ url: "", username: "", password: "" });
  readonly httpDraft = signal<HttpLogTransportInput>({
    enabled: false,
    url: "",
    level: "info",
    authType: "none",
    username: "",
    bearerToken: "",
    password: "",
    clearBearerToken: false,
    clearPassword: false
  });
  readonly saving = signal(false);
  readonly savingHttp = signal(false);

  /** Receives the shared manager API state used for broker settings. */
  constructor(readonly manager: ManagerStore) {}

  /** Initializes this page from the saved public broker configuration. */
  ngOnInit(): void { this.refresh(); }

  /** Refreshes the broker state and drops any unsaved form values. */
  refresh(): void {
    this.manager.refresh().subscribe({
      next: ({ config }) => {
        this.draft.set({ url: config.broker.url, username: config.broker.username, password: "" });
        this.httpDraft.set({
          enabled: config.httpLogTransport.enabled,
          url: config.httpLogTransport.url,
          level: config.httpLogTransport.level,
          authType: config.httpLogTransport.authType,
          username: config.httpLogTransport.username,
          bearerToken: "",
          password: "",
          clearBearerToken: false,
          clearPassword: false
        });
      },
      error: () => this.manager.inform("BROKER.ERROR_LOAD", "error")
    });
  }

  /** Updates only the URL field while preserving unsaved username/password values. */
  setUrl(url: string): void { this.draft.update((value) => ({ ...value, url })); }

  /** Updates only the username field in the reactive broker draft. */
  setUsername(username: string): void { this.draft.update((value) => ({ ...value, username })); }

  /** Updates only the password field in the reactive broker draft. */
  setPassword(password: string): void { this.draft.update((value) => ({ ...value, password })); }

  /** Saves connection details and lets the runtime reconnect to the broker. */
  save(): void {
    this.saving.set(true);
    this.manager.saveBroker(this.draft()).subscribe({
      next: ({ config }) => {
        // The API never echoes the stored password, so clear the secret field after a successful save.
        this.draft.set({ url: config.broker.url, username: config.broker.username, password: "" });
        this.saving.set(false);
        this.manager.inform("BROKER.NOTICE_SAVED");
      },
      error: (error) => { this.saving.set(false); this.manager.inform(error.error?.error || "BROKER.ERROR_SAVE", "error"); }
    });
  }

  /** Updates a non-secret value in the HTTP logging draft. */
  setHttpField<K extends "url" | "username">(field: K, value: HttpLogTransportInput[K]): void {
    this.httpDraft.update((draft) => ({ ...draft, [field]: value }));
  }

  /** Updates whether remote log forwarding is active. */
  setHttpEnabled(enabled: boolean): void {
    this.httpDraft.update((draft) => ({ ...draft, enabled }));
  }

  /** Changes the minimum severity forwarded to the remote endpoint. */
  setHttpLevel(level: HttpLogTransportInput["level"]): void {
    this.httpDraft.update((draft) => ({ ...draft, level }));
  }

  /** Changes the authentication mode and discards unsaved values for hidden secret fields. */
  setHttpAuthType(authType: HttpLogTransportInput["authType"]): void {
    this.httpDraft.update((draft) => ({
      ...draft,
      authType,
      bearerToken: "",
      password: "",
      clearBearerToken: false,
      clearPassword: false
    }));
  }

  /** Stores a new bearer token in the unsaved form state and cancels a pending clear. */
  setHttpBearerToken(bearerToken: string): void {
    this.httpDraft.update((draft) => ({ ...draft, bearerToken, clearBearerToken: false }));
  }

  /** Stores a new basic-auth password in the unsaved form state and cancels a pending clear. */
  setHttpPassword(password: string): void {
    this.httpDraft.update((draft) => ({ ...draft, password, clearPassword: false }));
  }

  /** Marks the saved bearer token for removal when the settings are saved. */
  clearHttpBearerToken(): void {
    this.httpDraft.update((draft) => ({ ...draft, bearerToken: "", clearBearerToken: true }));
  }

  /** Marks the saved basic-auth password for removal when the settings are saved. */
  clearHttpPassword(): void {
    this.httpDraft.update((draft) => ({ ...draft, password: "", clearPassword: true }));
  }

  /** Saves and activates the remote Winston transport without sending saved credentials to the browser. */
  saveHttpLogging(): void {
    this.savingHttp.set(true);
    this.manager.saveHttpLogTransport(this.httpDraft()).subscribe({
      next: ({ httpLogTransport }) => {
        this.httpDraft.update((draft) => ({
          ...draft,
          enabled: httpLogTransport.enabled,
          url: httpLogTransport.url,
          level: httpLogTransport.level,
          authType: httpLogTransport.authType,
          username: httpLogTransport.username,
          bearerToken: "",
          password: "",
          clearBearerToken: false,
          clearPassword: false
        }));
        this.savingHttp.set(false);
        this.manager.inform("BROKER.HTTP_LOG_NOTICE_SAVED");
      },
      error: (error) => {
        this.savingHttp.set(false);
        this.manager.inform(error.error?.error || "BROKER.HTTP_LOG_ERROR_SAVE", "error");
      }
    });
  }
}
