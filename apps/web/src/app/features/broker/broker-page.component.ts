import { Component, OnInit, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { ManagerStore } from "../../manager-store.service";
import type { BrokerInput } from "../../models";

/**
 * Configures the single MQTT connection shared by all panel profiles and routes.
 *
 * Broker credentials are sent only when saved. The API never returns the stored
 * password; leaving the password field blank preserves its existing value.
 */
@Component({
  selector: "nspanel-broker-page",
  standalone: true,
  imports: [FormsModule],
  templateUrl: "./broker-page.component.html",
  styleUrl: "./broker-page.component.css"
})
export class BrokerPageComponent implements OnInit {
  readonly draft = signal<BrokerInput>({ url: "", username: "", password: "" });
  readonly saving = signal(false);

  /** Receives the shared manager API state used for broker settings. */
  constructor(readonly manager: ManagerStore) {}

  /** Initializes this page from the saved public broker configuration. */
  ngOnInit(): void { this.refresh(); }

  /** Refreshes the broker state and drops any unsaved form values. */
  refresh(): void {
    this.manager.refresh().subscribe({
      next: ({ config }) => this.draft.set({ url: config.broker.url, username: config.broker.username, password: "" }),
      error: () => this.manager.inform("Could not load broker settings.", "error")
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
        this.draft.set({ url: config.broker.url, username: config.broker.username, password: "" });
        this.saving.set(false);
        this.manager.inform("Broker settings saved. The manager will reconnect automatically.");
      },
      error: (error) => { this.saving.set(false); this.manager.inform(error.error?.error || "Could not save broker settings.", "error"); }
    });
  }
}
