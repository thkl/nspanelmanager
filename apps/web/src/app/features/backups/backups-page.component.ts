import { CommonModule } from "@angular/common";
import { Component, OnInit, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { TranslatePipe } from "@ngx-translate/core";
import { ManagerStore } from "../../manager-store.service";
import type { BackupSettings, ConfigRevision, ConfigRevisionScopeTarget, ConfigRevisionScopeType, ConfigRevisionScopes } from "../../models";

/** Manages scheduled archives and full or scoped configuration recovery for administrators. */
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
  readonly scopeRevisionId = signal<number | null>(null);
  readonly scopeOptionsByRevision = signal<Record<number, ConfigRevisionScopes>>({});
  readonly loadingScopesRevisionId = signal<number | null>(null);
  readonly selectedScopeType = signal<ConfigRevisionScopeType>("panel");
  readonly selectedScopeTargetId = signal("");
  readonly scopeTypeOptions: Array<{ value: ConfigRevisionScopeType; labelKey: string }> = [
    { value: "panel", labelKey: "BACKUPS.SCOPE_PANEL" },
    { value: "plugin-profile", labelKey: "BACKUPS.SCOPE_PLUGIN_PROFILE" },
    { value: "plugin-instance", labelKey: "BACKUPS.SCOPE_PLUGIN_INSTANCE" }
  ];

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

  /** Opens the scoped restore selector and loads safe target labels for the revision. */
  toggleScopedRestore(revision: ConfigRevision): void {
    if (this.scopeRevisionId() === revision.id) {
      this.scopeRevisionId.set(null);
      return;
    }
    this.scopeRevisionId.set(revision.id);
    this.selectedScopeType.set("panel");
    this.selectedScopeTargetId.set("");
    const cached = this.scopeOptionsByRevision()[revision.id];
    if (cached) {
      this.selectFirstAvailableScope(cached);
      return;
    }

    this.loadingScopesRevisionId.set(revision.id);
    this.manager.loadConfigRevisionScopes(revision.id).subscribe({
      next: ({ scopes }) => {
        this.scopeOptionsByRevision.update((items) => ({ ...items, [revision.id]: scopes }));
        this.loadingScopesRevisionId.set(null);
        this.selectFirstAvailableScope(scopes);
      },
      error: () => {
        this.loadingScopesRevisionId.set(null);
        this.scopeRevisionId.set(null);
        this.manager.inform("BACKUPS.ERROR_LOAD_SCOPES", "error");
      }
    });
  }

  /** Returns the options for the selected scope kind in the currently open history row. */
  availableScopeTargets(): ConfigRevisionScopeTarget[] {
    const revisionId = this.scopeRevisionId();
    if (revisionId === null) return [];
    const options = this.scopeOptionsByRevision()[revisionId];
    if (!options) return [];
    return this.targetsForScope(options, this.selectedScopeType());
  }

  /** Hides scope categories that have no matching object in the selected revision. */
  scopeOptionAvailable(scope: ConfigRevisionScopeType): boolean {
    const revisionId = this.scopeRevisionId();
    const scopes = revisionId === null ? undefined : this.scopeOptionsByRevision()[revisionId];
    return Boolean(scopes && this.targetsForScope(scopes, scope).length > 0);
  }

  /** Switches the scope category and selects its first available object. */
  setSelectedScopeType(scope: ConfigRevisionScopeType): void {
    this.selectedScopeType.set(scope);
    this.selectedScopeTargetId.set(this.availableScopeTargets()[0]?.id ?? "");
  }

  /** Restores only the selected object, records the operation, and refreshes shared UI state. */
  restoreSelectedScope(revision: ConfigRevision): void {
    if (this.restoringRevisionId() !== null) return;
    const target = this.availableScopeTargets().find((item) => item.id === this.selectedScopeTargetId());
    if (!target) return;
    const createdAt = new Date(revision.createdAt).toLocaleString();
    if (!this.manager.confirm("BACKUPS.CONFIRM_SCOPED_RESTORE", { name: target.name, createdAt })) return;

    this.restoringRevisionId.set(revision.id);
    this.manager.restoreConfigRevisionScope(revision.id, this.selectedScopeType(), target.id).subscribe({
      next: () => this.manager.refresh().subscribe({
        next: () => {
          this.loadRevisions();
          this.scopeRevisionId.set(null);
          this.restoringRevisionId.set(null);
          this.manager.inform("BACKUPS.NOTICE_SCOPED_RESTORED");
        },
        error: () => {
          this.restoringRevisionId.set(null);
          this.manager.inform("BACKUPS.ERROR_REFRESH_AFTER_RESTORE", "error");
        }
      }),
      error: (error: unknown) => {
        this.restoringRevisionId.set(null);
        const message = (error as { error?: { error?: string } })?.error?.error;
        this.manager.inform(message || "BACKUPS.ERROR_SCOPED_RESTORE", "error");
      }
    });
  }

  /** Selects a sensible default category and target after loading revision metadata. */
  private selectFirstAvailableScope(scopes: ConfigRevisionScopes): void {
    const firstAvailable = this.scopeTypeOptions.find((option) => this.targetsForScope(scopes, option.value).length > 0);
    if (!firstAvailable) {
      this.selectedScopeTargetId.set("");
      return;
    }
    this.selectedScopeType.set(firstAvailable.value);
    this.selectedScopeTargetId.set(this.targetsForScope(scopes, firstAvailable.value)[0]?.id ?? "");
  }

  /** Resolves the target list for one supported restore scope. */
  private targetsForScope(scopes: ConfigRevisionScopes, scope: ConfigRevisionScopeType): ConfigRevisionScopeTarget[] {
    if (scope === "panel") return scopes.panels;
    if (scope === "plugin-profile") return scopes.pluginProfiles;
    return scopes.pluginInstances;
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
