import { CommonModule } from "@angular/common";
import { Component, OnInit, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { TranslatePipe } from "@ngx-translate/core";
import { ManagerStore } from "../../manager-store.service";
import type { BackupSettings, ConfigRevision } from "../../models";

/** Gives administrators a direct download for the manager's persistent data archive. */
@Component({
  selector: "nspanel-backups-page",
  standalone: true,
  imports: [CommonModule, FormsModule, TranslatePipe],
  templateUrl: "./backups-page.component.html",
  styleUrl: "./backups-page.component.css"
})
export class BackupsPageComponent implements OnInit {
  readonly draft = signal<BackupSettings>({ enabled: true, schedule: "0 3 * * *", retentionCount: 14, directory: "backups" });
  readonly saving = signal(false);
  readonly revisions = signal<ConfigRevision[]>([]);
  readonly restoringRevisionId = signal<number | null>(null);

  /** Receives the shared configuration and backup settings API. */
  constructor(readonly manager: ManagerStore) {}

  /** Loads the saved backup policy into the page draft. */
  ngOnInit(): void {
    this.manager.refresh().subscribe({
      next: ({ config }) => this.draft.set(structuredClone(config.backupSettings)),
      error: () => this.manager.inform("BACKUPS.ERROR_LOAD_SETTINGS", "error")
    });
    this.loadRevisions();
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
        this.manager.inform(backupSettings.enabled ? "BACKUPS.NOTICE_SAVED" : "BACKUPS.NOTICE_DISABLED");
      },
      error: (error: unknown) => {
        this.saving.set(false);
        const message = (error as { error?: { error?: string } })?.error?.error;
        this.manager.inform(message || "BACKUPS.ERROR_SAVE_SETTINGS", "error");
      }
    });
  }

  /** Disables saving if required values are missing or outside the accepted retention range. */
  settingsValid(): boolean {
    const settings = this.draft();
    return Boolean(settings.schedule.trim() && settings.directory.trim()) &&
      Number.isInteger(settings.retentionCount) && settings.retentionCount >= 1 && settings.retentionCount <= 365;
  }

  /** Loads revision metadata without exposing stored configuration snapshots to the browser. */
  loadRevisions(): void {
    this.manager.loadConfigRevisions().subscribe({
      next: ({ revisions }) => this.revisions.set(revisions),
      error: () => this.manager.inform("BACKUPS.ERROR_LOAD_HISTORY", "error")
    });
  }

  /** Restores a full saved manager configuration after explicit administrator confirmation. */
  restoreRevision(revision: ConfigRevision): void {
    if (this.restoringRevisionId() !== null) return;
    const createdAt = new Date(revision.createdAt).toLocaleString();
    if (!this.manager.confirm("BACKUPS.CONFIRM_RESTORE", { createdAt })) return;
    this.restoringRevisionId.set(revision.id);
    this.manager.restoreConfigRevision(revision.id).subscribe({
      // The revision endpoint saves the restored state; refresh the page draft from that canonical response.
      next: () => this.manager.refresh().subscribe({
        next: ({ config }) => {
          this.draft.set(structuredClone(config.backupSettings));
          this.loadRevisions();
          this.restoringRevisionId.set(null);
          this.manager.inform("BACKUPS.NOTICE_RESTORED");
        },
        error: () => {
          this.restoringRevisionId.set(null);
          this.manager.inform("BACKUPS.ERROR_REFRESH_AFTER_RESTORE", "error");
        }
      }),
      error: (error: unknown) => {
        this.restoringRevisionId.set(null);
        const message = (error as { error?: { error?: string } })?.error?.error;
        this.manager.inform(message || "BACKUPS.ERROR_RESTORE", "error");
      }
    });
  }
}
