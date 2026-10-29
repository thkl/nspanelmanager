import { HttpErrorResponse } from "@angular/common/http";
import { Component, ElementRef, OnInit, signal, viewChild } from "@angular/core";
import { TranslatePipe } from "@ngx-translate/core";
import { ManagerStore } from "../../manager-store.service";
import type { FirmwareArtifact, FirmwareRolloutSettings, FirmwareUpdateJob, HmiArtifact, HmiCompatibilityProfile, HmiUpdateJob, Panel } from "../../models";

type UpdateTab = "firmware" | "hmi";

/** Uploads firmware or a Nextion TFT and requests updates on registered panels. */
@Component({
  selector: "nspanel-hmi-page",
  standalone: true,
  imports: [TranslatePipe],
  templateUrl: "./hmi-page.component.html",
  styleUrl: "./hmi-page.component.css"
})
export class HmiPageComponent implements OnInit {
  readonly activeTab = signal<UpdateTab>("firmware");
  readonly artifact = signal<HmiArtifact | null>(null);
  readonly firmwareArtifact = signal<FirmwareArtifact | null>(null);
  readonly selectedFile = signal<File | null>(null);
  readonly selectedFirmwareFile = signal<File | null>(null);
  readonly loading = signal(true);
  readonly firmwareLoading = signal(true);
  readonly uploading = signal(false);
  readonly uploadingFirmware = signal(false);
  readonly updatingPanelId = signal("");
  readonly updatingFirmwarePanelId = signal("");
  readonly rolloutEnabled = signal(false);
  readonly rolloutStableHours = signal(3);
  readonly savingRolloutSettings = signal(false);
  readonly cancellingRollout = signal(false);
  readonly savingAutoUpdatePanelId = signal("");
  readonly stagingFirmwarePanelId = signal("");
  readonly forceUpdate = signal(false);
  readonly forceFirmwareUpdate = signal(false);
  readonly selectedCompatibilityProfiles = signal<HmiCompatibilityProfile[]>(["legacy", "unified"]);
  readonly hmiCanaryPanelId = signal("");
  readonly hmiRolloutTargetPanelIds = signal<string[]>([]);
  readonly startingHmiRollout = signal(false);
  readonly cancellingHmiRollout = signal(false);
  readonly maxUploadBytes = signal(32 * 1024 * 1024);
  readonly maxFirmwareUploadBytes = signal(8 * 1024 * 1024 + 64 * 1024);
  readonly fileInput = viewChild<ElementRef<HTMLInputElement>>("fileInput");
  readonly firmwareFileInput = viewChild<ElementRef<HTMLInputElement>>("firmwareFileInput");
  readonly firmwareTab = viewChild<ElementRef<HTMLButtonElement>>("firmwareTab");
  readonly hmiTab = viewChild<ElementRef<HTMLButtonElement>>("hmiTab");

  /** Shares configured panels and API operations with the workspace. */
  constructor(readonly manager: ManagerStore) {}

  /** Selects a panel update tab. */
  selectTab(tab: UpdateTab): void {
    this.activeTab.set(tab);
  }

  /** Supports the expected arrow and Home/End navigation for the tab list. */
  handleTabKeydown(event: KeyboardEvent): void {
    let nextTab: UpdateTab | undefined;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      nextTab = this.activeTab() === "firmware" ? "hmi" : "firmware";
    } else if (event.key === "Home") {
      nextTab = "firmware";
    } else if (event.key === "End") {
      nextTab = "hmi";
    }
    if (!nextTab) return;
    event.preventDefault();
    this.selectTab(nextTab);
    const tab = nextTab === "firmware" ? this.firmwareTab() : this.hmiTab();
    tab?.nativeElement.focus();
  }

  /** Loads the currently stored TFT metadata when the HMI workspace opens. */
  ngOnInit(): void {
    this.refresh();
  }

  /** Refreshes update artifacts and the saved rollout policy. */
  refresh(): void {
    // Fetch configuration and each artifact independently so a missing upload does not hide the other tab.
    this.manager.refresh().subscribe({
      next: ({ config }) => {
        this.rolloutEnabled.set(config.firmwareRollout.enabled);
        this.rolloutStableHours.set(config.firmwareRollout.stableHours);
      },
      error: () => this.manager.inform("HMI.ERROR_LOAD_ROLLOUT_SETTINGS", "error")
    });
    this.loading.set(true);
    this.manager.loadHmiArtifact().subscribe({
      next: ({ artifact, maxUploadBytes }) => {
        this.artifact.set(artifact);
        this.maxUploadBytes.set(maxUploadBytes);
        this.loading.set(false);
      },
      error: (error: unknown) => {
        this.loading.set(false);
        this.manager.inform(this.errorMessage(error), "error");
      }
    });
    this.manager.loadFirmwareArtifact().subscribe({
      next: ({ artifact, maxUploadBytes }) => {
        this.firmwareArtifact.set(artifact);
        this.maxFirmwareUploadBytes.set(maxUploadBytes);
        this.firmwareLoading.set(false);
      },
      error: (error: unknown) => {
        this.firmwareLoading.set(false);
        this.manager.inform(this.errorMessage(error), "error");
      }
    });
  }

  /** Reads the staged-rollout checkbox without saving until the administrator applies the settings. */
  setRolloutEnabled(event: Event): void {
    const target = event.target;
    if (target instanceof HTMLInputElement) this.rolloutEnabled.set(target.checked);
  }

  /** Keeps the canary stability period within the supported whole-hour range. */
  setRolloutStableHours(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const value = Number(target.value);
    this.rolloutStableHours.set(Number.isInteger(value) ? value : 0);
  }

  /** Persists the global rollout gate and stability window. */
  saveRolloutSettings(): void {
    const settings: FirmwareRolloutSettings = { enabled: this.rolloutEnabled(), stableHours: this.rolloutStableHours() };
    if (!this.rolloutSettingsValid() || this.savingRolloutSettings()) return;
    this.savingRolloutSettings.set(true);
    this.manager.saveFirmwareRolloutSettings(settings).subscribe({
      next: () => {
        this.savingRolloutSettings.set(false);
        this.manager.inform(settings.enabled ? "HMI.NOTICE_ROLLOUT_SETTINGS_SAVED" : "HMI.NOTICE_ROLLOUT_DISABLED");
      },
      error: (error: unknown) => {
        this.savingRolloutSettings.set(false);
        this.manager.inform(this.errorMessage(error), "error");
      }
    });
  }

  /** Enables saving only when the configured stability window is a supported whole-hour value. */
  rolloutSettingsValid(): boolean {
    const hours = this.rolloutStableHours();
    return Number.isInteger(hours) && hours >= 1 && hours <= 24;
  }

  /** Resolves the currently active rollout target to its configured panel name. */
  rolloutCurrentPanelName(): string {
    const panelId = this.manager.firmwareRollout()?.currentPanelId;
    return this.manager.config().panels.find((panel) => panel.id === panelId)?.name ?? "panel";
  }

  /** Cancels the active rollout while allowing a panel update already sent to finish. */
  cancelFirmwareRollout(): void {
    const rollout = this.manager.firmwareRollout();
    if (!rollout || (rollout.status !== "monitoring" && rollout.status !== "updating") || this.cancellingRollout()) return;
    this.cancellingRollout.set(true);
    this.manager.cancelFirmwareRollout().subscribe({
      next: () => {
        this.cancellingRollout.set(false);
        this.manager.inform("HMI.NOTICE_ROLLOUT_CANCELLED");
      },
      error: (error: unknown) => {
        this.cancellingRollout.set(false);
        this.manager.inform(this.errorMessage(error), "error");
      }
    });
  }

  /** Saves one panel's opt-in for future automatic rollout stages. */
  setAutoUpdatePanel(panel: Panel, event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || this.savingAutoUpdatePanelId()) return;
    this.savingAutoUpdatePanelId.set(panel.id);
    this.manager.setPanelAutoUpdateFirmware(panel.id, target.checked).subscribe({
      next: () => {
        this.savingAutoUpdatePanelId.set("");
        this.manager.inform(target.checked ? "HMI.NOTICE_PANEL_AUTO_ENABLED" : "HMI.NOTICE_PANEL_AUTO_DISABLED", "success", { name: panel.name });
      },
      error: (error: unknown) => {
        this.savingAutoUpdatePanelId.set("");
        this.manager.inform(this.errorMessage(error), "error");
      }
    });
  }

  /** Starts canary monitoring without reflashing a panel already running the uploaded firmware. */
  stageFirmwareRollout(panel: Panel): void {
    if (this.stagingFirmwarePanelId() || !this.canStageFirmwareRollout(panel)) return;
    this.stagingFirmwarePanelId.set(panel.id);
    this.manager.stageFirmwareRollout(panel.id).subscribe({
      next: ({ rollout }) => {
        this.stagingFirmwarePanelId.set("");
        this.manager.inform("HMI.NOTICE_ROLLOUT_STAGED", "success", { version: rollout.firmwareVersion, name: panel.name, hours: rollout.stableHours });
      },
      error: (error: unknown) => {
        this.stagingFirmwarePanelId.set("");
        this.manager.inform(this.errorMessage(error), "error");
      }
    });
  }

  /** Shows the restage action when this panel runs the uploaded version and recipients are opted in. */
  canStageFirmwareRollout(panel: Panel): boolean {
    const connection = this.manager.panelConnections()[panel.nodeName];
    const telemetry = connection?.telemetry;
    return this.manager.config().firmwareRollout.enabled
      && panel.unifiedFirmware === true
      && connection?.status === "online"
      && this.firmwareVersionMatches(panel)
      && typeof telemetry?.uptimeSeconds === "number"
      && Date.now() - telemetry.reportedAt <= 180_000
      && this.manager.config().panels.some((candidate) => candidate.id !== panel.id
        && candidate.unifiedFirmware === true && candidate.autoUpdateFirmware === true);
  }

  /** Keeps one selected `.tft` file and checks the configured size limit in the browser. */
  selectFile(event: Event): void {
    const input = event.target;
    const file = input instanceof HTMLInputElement ? input.files?.[0] : undefined;
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".tft")) {
      this.clearFileSelection();
      this.manager.inform("HMI.ERROR_CHOOSE_TFT", "error");
      return;
    }
    if (file.size === 0 || file.size > this.maxUploadBytes()) {
      this.clearFileSelection();
      this.manager.inform("HMI.ERROR_TFT_FILE_SIZE", "error", { size: this.formatSize(this.maxUploadBytes()) });
      return;
    }
    this.selectedFile.set(file);
  }

  /** Uploads the selected TFT and updates the current artifact shown on this page. */
  upload(): void {
    const file = this.selectedFile();
    if (!file || this.uploading()) return;
    this.uploading.set(true);
    this.manager.uploadHmi(file, this.selectedCompatibilityProfiles()).subscribe({
      next: ({ artifact }) => {
        this.artifact.set(artifact);
        this.uploading.set(false);
        this.clearFileSelection();
        this.manager.inform("HMI.NOTICE_HMI_UPLOADED", "success", { filename: artifact.filename });
      },
      error: (error: unknown) => {
        this.uploading.set(false);
        this.manager.inform(this.errorMessage(error), "error");
      }
    });
  }

  /** Keeps one versioned firmware package and checks its configured size limit. */
  selectFirmwareFile(event: Event): void {
    const input = event.target;
    const file = input instanceof HTMLInputElement ? input.files?.[0] : undefined;
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".zip")) {
      this.clearFirmwareFileSelection();
      this.manager.inform("HMI.ERROR_CHOOSE_FIRMWARE_PACKAGE", "error");
      return;
    }
    if (file.size === 0 || file.size > this.maxFirmwareUploadBytes()) {
      this.clearFirmwareFileSelection();
      this.manager.inform("HMI.ERROR_FIRMWARE_FILE_SIZE", "error", { size: this.formatSize(this.maxFirmwareUploadBytes()) });
      return;
    }
    this.selectedFirmwareFile.set(file);
  }

  /** Uploads the selected package; the manager reads its firmware version from manifest.json. */
  uploadFirmware(): void {
    const file = this.selectedFirmwareFile();
    if (!file || this.uploadingFirmware()) return;
    this.uploadingFirmware.set(true);
    this.manager.uploadFirmware(file).subscribe({
      next: ({ artifact }) => {
        this.firmwareArtifact.set(artifact);
        this.uploadingFirmware.set(false);
        this.clearFirmwareFileSelection();
        this.manager.inform("HMI.NOTICE_FIRMWARE_UPLOADED", "success", { filename: artifact.filename, version: artifact.version });
      },
      error: (error: unknown) => {
        this.uploadingFirmware.set(false);
        this.manager.inform(this.errorMessage(error), "error");
      }
    });
  }

  /** Requests a manager-hosted firmware download on the selected panel. */
  requestFirmwareUpdate(panel: Panel): void {
    if (this.updatingFirmwarePanelId() || !this.firmwareArtifact() || !this.manager.mqtt().connected) return;
    const force = this.forceFirmwareUpdate();
    this.updatingFirmwarePanelId.set(panel.id);
    this.manager.requestFirmwareUpdate(panel.id, force).subscribe({
      next: ({ expiresAt, firmwareVersion }) => {
        this.updatingFirmwarePanelId.set("");
        this.manager.inform(force ? "HMI.NOTICE_FW_FORCE_STARTED" : "HMI.NOTICE_FW_PROMPT_SENT", "success", {
          version: firmwareVersion,
          name: panel.name,
          expiresAt: this.formatTimestamp(expiresAt)
        });
      },
      error: (error: unknown) => {
        this.updatingFirmwarePanelId.set("");
        this.manager.inform(this.errorMessage(error), "error");
      }
    });
  }

  /** Returns the latest firmware update attempt for one configured panel. */
  latestFirmwareUpdate(panel: Panel): FirmwareUpdateJob | undefined {
    return this.manager.firmwareUpdateJobs().find((job) => job.panelId === panel.id);
  }

  /** Identifies firmware updates still waiting for the panel or reboot. */
  firmwareUpdateInProgress(panel: Panel): boolean {
    const status = this.latestFirmwareUpdate(panel)?.status;
    return status === "sending" || status === "sent" || status === "awaiting_confirmation" || status === "uploading" || status === "rebooting";
  }

  /** Compares a panel's reported firmware version with the currently uploaded binary. */
  firmwareVersionLabel(panel: Panel): string {
    const reported = this.manager.panelConnections()[panel.nodeName]?.telemetry?.firmwareVersion;
    if (!reported) return this.manager.translateText("HMI.FW_VERSION_UNKNOWN");
    if (reported === this.firmwareArtifact()?.version) return this.manager.translateText("HMI.FW_VERSION_CURRENT", { version: reported });
    return this.manager.translateText("HMI.FW_VERSION_DIFFERS", { version: reported });
  }

  /** Returns whether the panel's ping reports the uploaded firmware version. */
  firmwareVersionMatches(panel: Panel): boolean {
    const reported = this.manager.panelConnections()[panel.nodeName]?.telemetry?.firmwareVersion;
    return Boolean(reported && reported === this.firmwareArtifact()?.version);
  }

  /** Shows the stable bootstrap command topic used for panel update requests. */
  updateCommandTopic(panel: Panel, command: "updatefirmware" | "updatehmi"): string {
    const macAddress = panel.macAddress?.replace(/[:-]/g, "").toLowerCase();
    const topicRoot = panel.unifiedFirmware && macAddress && /^[a-f0-9]{12}$/.test(macAddress)
      ? `nspanel/nspanel-${macAddress.slice(-6)}`
      : panel.nodeName;
    return `${topicRoot}/cmnd/${command}`;
  }

  /** Provides concise wording for a firmware update lifecycle state. */
  firmwareUpdateStatusLabel(job: FirmwareUpdateJob): string {
    switch (job.status) {
      case "sending": return this.manager.translateText("HMI.STATUS_SENDING_REQUEST");
      case "sent": return this.manager.translateText("HMI.STATUS_WAITING_PANEL");
      case "awaiting_confirmation": return this.manager.translateText("HMI.STATUS_AWAITING_CONFIRMATION");
      case "uploading": return job.progress === undefined
        ? this.manager.translateText("HMI.STATUS_DOWNLOADING_FIRMWARE")
        : this.manager.translateText("HMI.STATUS_DOWNLOADING_PROGRESS", { progress: job.progress });
      case "rebooting": return this.manager.translateText("HMI.STATUS_RESTARTING_PANEL");
      case "succeeded": return this.manager.translateText("HMI.STATUS_INSTALLED");
      case "failed": return this.manager.translateText("HMI.STATUS_FAILED");
      case "cancelled": return this.manager.translateText("HMI.STATUS_CANCELLED");
      case "timed_out": return this.manager.translateText("HMI.STATUS_TIMED_OUT");
    }
  }

  /** Sends a fresh temporary download URL to the selected panel over MQTT. */
  requestUpdate(panel: Panel): void {
    if (this.updatingPanelId() || !this.artifact() || !this.manager.mqtt().connected) return;
    const force = this.forceUpdate();
    this.updatingPanelId.set(panel.id);
    this.manager.requestHmiUpdate(panel.id, force).subscribe({
      next: ({ expiresAt, hmiVersion }) => {
        this.updatingPanelId.set("");
        const shortVersion = hmiVersion.slice(0, 12);
        this.manager.inform(force ? "HMI.NOTICE_HMI_FORCE_STARTED" : "HMI.NOTICE_HMI_PROMPT_SENT", "success", {
          version: shortVersion,
          name: panel.name,
          expiresAt: this.formatTimestamp(expiresAt)
        });
      },
      error: (error: unknown) => {
        this.updatingPanelId.set("");
        this.manager.inform(this.errorMessage(error), "error");
      }
    });
  }

  /** Compares a panel's reported HMI artifact hash with the currently uploaded TFT. */
  hmiVersionLabel(panel: Panel): string {
    const reported = this.manager.panelConnections()[panel.nodeName]?.telemetry?.hmiVersion;
    if (!reported) return this.manager.translateText("HMI.HMI_VERSION_UNKNOWN");
    if (reported === this.artifact()?.sha256) return this.manager.translateText("HMI.HMI_VERSION_CURRENT", { version: reported.slice(0, 12) });
    return this.manager.translateText("HMI.HMI_VERSION_DIFFERS", { version: reported.slice(0, 12) });
  }

  /** Returns whether the panel has reported the current artifact's exact content hash. */
  hmiVersionMatches(panel: Panel): boolean {
    const reported = this.manager.panelConnections()[panel.nodeName]?.telemetry?.hmiVersion;
    return Boolean(reported && reported === this.artifact()?.sha256);
  }

  /** Returns the latest durable update attempt for one configured panel. */
  latestUpdate(panel: Panel): HmiUpdateJob | undefined {
    return this.manager.hmiUpdateJobs().find((job) => job.panelId === panel.id);
  }

  /** Identifies jobs that are still awaiting a panel response or completion. */
  updateInProgress(panel: Panel): boolean {
    const status = this.latestUpdate(panel)?.status;
    return status === "sending" || status === "sent" || status === "awaiting_confirmation" || status === "uploading";
  }

  /** Provides concise wording for the lifecycle state shown beside each panel. */
  updateStatusLabel(job: HmiUpdateJob): string {
    switch (job.status) {
      case "sending": return this.manager.translateText("HMI.STATUS_SENDING_REQUEST");
      case "sent": return this.manager.translateText("HMI.STATUS_WAITING_PANEL");
      case "awaiting_confirmation": return this.manager.translateText("HMI.STATUS_AWAITING_CONFIRMATION");
      case "uploading": return this.manager.translateText("HMI.STATUS_UPDATING_DISPLAY");
      case "succeeded": return this.manager.translateText("HMI.STATUS_INSTALLED");
      case "failed": return this.manager.translateText("HMI.STATUS_FAILED");
      case "cancelled": return this.manager.translateText("HMI.STATUS_CANCELLED");
      case "timed_out": return this.manager.translateText("HMI.STATUS_TIMED_OUT");
    }
  }

  /** Formats the manager's recorded job time using the browser's local timezone. */
  formatJobTime(value: number): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? this.manager.translateText("HMI.UNKNOWN_TIME") : date.toLocaleString();
  }

  /** Updates the firmware profiles that the uploaded TFT is known to support. */
  setCompatibilityProfile(profile: HmiCompatibilityProfile, event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    this.selectedCompatibilityProfiles.update((profiles) => {
      const next = target.checked
        ? [...new Set([...profiles, profile])]
        : profiles.filter((item) => item !== profile);
      return next.length > 0 ? next : profiles;
    });
  }

  /** Reports whether an artifact can be safely sent to the selected panel family. */
  isHmiCompatible(panel: Panel): boolean {
    const profile = panel.unifiedFirmware === true ? "unified" : "legacy";
    return this.artifact()?.compatibleProfiles.includes(profile) ?? false;
  }

  /** Changes the canary and removes it from the queued target selection. */
  setHmiCanary(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    this.hmiCanaryPanelId.set(target.value);
    this.hmiRolloutTargetPanelIds.update((panelIds) => panelIds.filter((panelId) => panelId !== target.value));
  }

  /** Adds or removes a target from the staged HMI rollout panel queue. */
  setHmiRolloutTarget(panelId: string, event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    this.hmiRolloutTargetPanelIds.update((panelIds) => target.checked
      ? [...new Set([...panelIds, panelId])]
      : panelIds.filter((item) => item !== panelId));
  }

  /** Starts a rollout that waits for each panel to confirm the exact TFT version. */
  startHmiRollout(): void {
    const canaryPanelId = this.hmiCanaryPanelId();
    const targetPanelIds = this.hmiRolloutTargetPanelIds();
    if (!canaryPanelId || targetPanelIds.length === 0 || !this.canStartHmiRollout()) return;
    this.startingHmiRollout.set(true);
    this.manager.startHmiRollout(canaryPanelId, targetPanelIds, this.forceUpdate()).subscribe({
      next: ({ rollout }) => {
        this.startingHmiRollout.set(false);
        this.manager.hmiRollout.set(rollout);
        this.manager.inform("HMI.NOTICE_HMI_ROLLOUT_STARTED", "success", {
          canary: rollout.canaryPanelName,
          count: String(targetPanelIds.length)
        });
      },
      error: (error: unknown) => {
        this.startingHmiRollout.set(false);
        this.manager.inform(this.errorMessage(error), "error");
      }
    });
  }

  /** Cancels the queue so the manager does not start another panel update. */
  cancelHmiRollout(): void {
    if (!this.hmiRolloutActive() || this.cancellingHmiRollout()) return;
    this.cancellingHmiRollout.set(true);
    this.manager.cancelHmiRollout().subscribe({
      next: () => {
        this.cancellingHmiRollout.set(false);
        this.manager.inform("HMI.NOTICE_HMI_ROLLOUT_CANCELLED");
      },
      error: (error: unknown) => {
        this.cancellingHmiRollout.set(false);
        this.manager.inform(this.errorMessage(error), "error");
      }
    });
  }

  /** Checks that selected panels are compatible and have no other update in progress. */
  canStartHmiRollout(): boolean {
    if (!this.artifact() || !this.manager.mqtt().connected || this.startingHmiRollout() || this.hmiRolloutActive()) return false;
    const canaryPanelId = this.hmiCanaryPanelId();
    const targets = this.hmiRolloutTargetPanelIds();
    if (!canaryPanelId || targets.length === 0 || targets.includes(canaryPanelId)) return false;
    return [canaryPanelId, ...targets].every((panelId) => {
      const panel = this.manager.config().panels.find((candidate) => candidate.id === panelId);
      return Boolean(panel && this.isHmiCompatible(panel) && !this.updateInProgress(panel) && !this.firmwareUpdateInProgress(panel));
    });
  }

  /** Returns whether the staged HMI rollout currently owns the update queue. */
  hmiRolloutActive(): boolean {
    return this.manager.hmiRollout()?.status === "updating";
  }

  /** Resolves a panel identifier for a readable rollout progress summary. */
  hmiRolloutPanelName(panelId: string | undefined): string {
    return this.manager.config().panels.find((panel) => panel.id === panelId)?.name ?? "panel";
  }

  /** Returns names for panels still waiting in the rollout queue. */
  hmiRolloutPendingNames(): string {
    const rollout = this.manager.hmiRollout();
    if (!rollout) return "";
    return rollout.pendingPanelIds.map((panelId) => this.hmiRolloutPanelName(panelId)).join(", ");
  }

  /** Updates whether the next panel request should bypass the on-panel confirmation. */
  setForceUpdate(event: Event): void {
    const target = event.target;
    if (target instanceof HTMLInputElement) this.forceUpdate.set(target.checked);
  }

  /** Updates whether the next firmware request should bypass on-panel confirmation. */
  setForceFirmwareUpdate(event: Event): void {
    const target = event.target;
    if (target instanceof HTMLInputElement) this.forceFirmwareUpdate.set(target.checked);
  }

  /** Formats artifact size for the uploaded-file summary. */
  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB"];
    let size = bytes / 1024;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
    return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`;
  }

  /** Formats timestamps using the browser's local timezone. */
  formatTimestamp(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
  }

  private clearFileSelection(): void {
    this.selectedFile.set(null);
    const input = this.fileInput();
    if (input) input.nativeElement.value = "";
  }

  private clearFirmwareFileSelection(): void {
    this.selectedFirmwareFile.set(null);
    const input = this.firmwareFileInput();
    if (input) input.nativeElement.value = "";
  }

  private errorMessage(error: unknown): string {
    if (error instanceof HttpErrorResponse) {
      const body = error.error as { error?: unknown } | null;
      if (typeof body?.error === "string") return body.error;
      return error.status
        ? this.manager.translateText("HMI.ERROR_REQUEST_STATUS", { status: error.status })
        : this.manager.translateText("HMI.ERROR_API_UNAVAILABLE");
    }
    return this.manager.translateText("HMI.ERROR_REQUEST_FAILED");
  }
}
