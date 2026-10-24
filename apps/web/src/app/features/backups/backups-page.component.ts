import { Component, OnInit, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { ManagerStore } from "../../manager-store.service";
import type { BackupSettings } from "../../models";

/** Gives administrators a direct download for the manager's persistent data archive. */
@Component({
  selector: "nspanel-backups-page",
  standalone: true,
  imports: [FormsModule],
  templateUrl: "./backups-page.component.html",
  styleUrl: "./backups-page.component.css"
})
export class BackupsPageComponent implements OnInit {
  readonly draft = signal<BackupSettings>({ enabled: true, schedule: "0 3 * * *", retentionCount: 14, directory: "backups" });
  readonly saving = signal(false);

  /** Receives the shared configuration and backup settings API. */
  constructor(readonly manager: ManagerStore) {}

  /** Loads the saved backup policy into the page draft. */
  ngOnInit(): void {
    this.manager.refresh().subscribe({
      next: ({ config }) => this.draft.set(structuredClone(config.backupSettings)),
      error: () => this.manager.inform("Could not load backup settings.", "error")
    });
  }

  /** Updates the schedule draft without saving it before the administrator applies changes. */
  setSchedule(schedule: string): void { this.draft.update((settings) => ({ ...settings, schedule })); }

  /** Updates the target folder draft without changing the saved runtime setting. */
  setDirectory(directory: string): void { this.draft.update((settings) => ({ ...settings, directory })); }

  /** Keeps the retention draft numeric while the form is being edited. */
  setRetentionCount(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const retentionCount = Number(target.value);
    this.draft.update((settings) => ({ ...settings, retentionCount: Number.isInteger(retentionCount) ? retentionCount : 0 }));
  }

  /** Updates the enabled state of scheduled ZIP generation. */
  setEnabled(event: Event): void {
    const target = event.target;
    if (target instanceof HTMLInputElement) this.draft.update((settings) => ({ ...settings, enabled: target.checked }));
  }

  /** Saves the cron policy, target folder, and retention limit. */
  saveSettings(): void {
    const settings = this.draft();
    if (!this.settingsValid() || this.saving()) return;
    this.saving.set(true);
    this.manager.saveBackupSettings(settings).subscribe({
      next: ({ backupSettings }) => {
        this.draft.set(structuredClone(backupSettings));
        this.saving.set(false);
        this.manager.inform(backupSettings.enabled ? "Scheduled backup settings saved." : "Scheduled backups disabled.");
      },
      error: (error: unknown) => {
        this.saving.set(false);
        const message = (error as { error?: { error?: string } })?.error?.error;
        this.manager.inform(message || "Could not save backup settings.", "error");
      }
    });
  }

  /** Disables saving if required values are missing or outside the accepted retention range. */
  settingsValid(): boolean {
    const settings = this.draft();
    return Boolean(settings.schedule.trim() && settings.directory.trim()) &&
      Number.isInteger(settings.retentionCount) && settings.retentionCount >= 1 && settings.retentionCount <= 365;
  }
}
