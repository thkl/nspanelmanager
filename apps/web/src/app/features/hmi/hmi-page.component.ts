import { HttpErrorResponse } from "@angular/common/http";
import { Component, ElementRef, OnInit, signal, viewChild } from "@angular/core";
import { ManagerStore } from "../../manager-store.service";
import type { FirmwareArtifact, FirmwareUpdateJob, HmiArtifact, HmiUpdateJob, Panel } from "../../models";

type UpdateTab = "firmware" | "hmi";

/** Uploads firmware or a Nextion TFT and requests updates on registered panels. */
@Component({
  selector: "nspanel-hmi-page",
  standalone: true,
  templateUrl: "./hmi-page.component.html",
  styleUrl: "./hmi-page.component.css"
})
export class HmiPageComponent implements OnInit {
  readonly activeTab = signal<UpdateTab>("firmware");
  readonly artifact = signal<HmiArtifact | null>(null);
  readonly firmwareArtifact = signal<FirmwareArtifact | null>(null);
  readonly selectedFile = signal<File | null>(null);
  readonly selectedFirmwareFile = signal<File | null>(null);
  readonly firmwareVersion = signal("");
  readonly loading = signal(true);
  readonly firmwareLoading = signal(true);
  readonly uploading = signal(false);
  readonly uploadingFirmware = signal(false);
  readonly updatingPanelId = signal("");
  readonly updatingFirmwarePanelId = signal("");
  readonly forceUpdate = signal(false);
  readonly forceFirmwareUpdate = signal(false);
  readonly maxUploadBytes = signal(32 * 1024 * 1024);
  readonly maxFirmwareUploadBytes = signal(8 * 1024 * 1024);
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

  /** Refreshes the latest artifact without reloading editable panel configuration. */
  refresh(): void {
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

  /** Keeps one selected `.tft` file and checks the configured size limit in the browser. */
  selectFile(event: Event): void {
    const input = event.target;
    const file = input instanceof HTMLInputElement ? input.files?.[0] : undefined;
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".tft")) {
      this.clearFileSelection();
      this.manager.inform("Choose a file with the .tft extension.", "error");
      return;
    }
    if (file.size === 0 || file.size > this.maxUploadBytes()) {
      this.clearFileSelection();
      this.manager.inform(`Choose a non-empty TFT file smaller than ${this.formatSize(this.maxUploadBytes())}.`, "error");
      return;
    }
    this.selectedFile.set(file);
  }

  /** Uploads the selected TFT and updates the current artifact shown on this page. */
  upload(): void {
    const file = this.selectedFile();
    if (!file || this.uploading()) return;
    this.uploading.set(true);
    this.manager.uploadHmi(file).subscribe({
      next: ({ artifact }) => {
        this.artifact.set(artifact);
        this.uploading.set(false);
        this.clearFileSelection();
        this.manager.inform(`${artifact.filename} uploaded. Select a panel to send the update prompt.`);
      },
      error: (error: unknown) => {
        this.uploading.set(false);
        this.manager.inform(this.errorMessage(error), "error");
      }
    });
  }

  /** Keeps one selected ESPHome OTA binary and checks its configured size limit. */
  selectFirmwareFile(event: Event): void {
    const input = event.target;
    const file = input instanceof HTMLInputElement ? input.files?.[0] : undefined;
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".bin")) {
      this.clearFirmwareFileSelection();
      this.manager.inform("Choose an ESPHome OTA file with the .bin extension.", "error");
      return;
    }
    if (file.size === 0 || file.size > this.maxFirmwareUploadBytes()) {
      this.clearFirmwareFileSelection();
      this.manager.inform(`Choose a non-empty firmware file smaller than ${this.formatSize(this.maxFirmwareUploadBytes())}.`, "error");
      return;
    }
    this.selectedFirmwareFile.set(file);
  }

  /** Uploads the selected binary with the exact firmware version embedded at compile time. */
  uploadFirmware(): void {
    const file = this.selectedFirmwareFile();
    const version = this.firmwareVersion().trim();
    if (!file || !version || this.uploadingFirmware()) return;
    this.uploadingFirmware.set(true);
    this.manager.uploadFirmware(file, version).subscribe({
      next: ({ artifact }) => {
        this.firmwareArtifact.set(artifact);
        this.uploadingFirmware.set(false);
        this.clearFirmwareFileSelection();
        this.manager.inform(`${artifact.filename} (${artifact.version}) uploaded. Select a panel to send the firmware update.`);
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
        this.manager.inform(force
          ? `Forced firmware update ${firmwareVersion} started on ${panel.name}.`
          : `Firmware update ${firmwareVersion} prompt sent to ${panel.name}; confirm on the panel before ${this.formatTimestamp(expiresAt)}.`);
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
    if (!reported) return "Installed firmware version not reported yet";
    if (reported === this.firmwareArtifact()?.version) return `Installed firmware ${reported} · current`;
    return `Installed firmware ${reported} · differs from uploaded file`;
  }

  /** Returns whether the panel's ping reports the uploaded firmware version. */
  firmwareVersionMatches(panel: Panel): boolean {
    const reported = this.manager.panelConnections()[panel.nodeName]?.telemetry?.firmwareVersion;
    return Boolean(reported && reported === this.firmwareArtifact()?.version);
  }

  /** Provides concise wording for a firmware update lifecycle state. */
  firmwareUpdateStatusLabel(job: FirmwareUpdateJob): string {
    switch (job.status) {
      case "sending": return "Sending request";
      case "sent": return "Waiting for panel";
      case "awaiting_confirmation": return "Awaiting confirmation";
      case "uploading": return job.progress === undefined ? "Downloading firmware" : `Downloading firmware · ${job.progress}%`;
      case "rebooting": return "Restarting panel";
      case "succeeded": return "Installed successfully";
      case "failed": return "Failed";
      case "cancelled": return "Cancelled";
      case "timed_out": return "Timed out";
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
        this.manager.inform(force
          ? `Forced HMI update ${shortVersion} started on ${panel.name}; the panel will not ask for confirmation.`
          : `HMI update ${shortVersion} prompt sent to ${panel.name}. Press UPDATE on the panel to begin; its download link expires at ${this.formatTimestamp(expiresAt)}.`);
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
    if (!reported) return "Installed HMI version not reported yet";
    if (reported === this.artifact()?.sha256) return `Installed HMI ${reported.slice(0, 12)} · current`;
    return `Installed HMI ${reported.slice(0, 12)} · differs from uploaded file`;
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
      case "sending": return "Sending request";
      case "sent": return "Waiting for panel";
      case "awaiting_confirmation": return "Awaiting confirmation";
      case "uploading": return "Updating display";
      case "succeeded": return "Installed successfully";
      case "failed": return "Failed";
      case "cancelled": return "Cancelled";
      case "timed_out": return "Timed out";
    }
  }

  /** Formats the manager's recorded job time using the browser's local timezone. */
  formatJobTime(value: number): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Unknown time" : date.toLocaleString();
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

  /** Keeps the compiled firmware version associated with the selected binary. */
  setFirmwareVersion(event: Event): void {
    const target = event.target;
    if (target instanceof HTMLInputElement) this.firmwareVersion.set(target.value);
  }

  /** Checks the version syntax accepted by the firmware update command. */
  firmwareVersionValid(): boolean {
    return /^[0-9A-Za-z._+-]{1,40}$/.test(this.firmwareVersion().trim());
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
      return error.status ? `The HMI request failed (${error.status}).` : "The manager API is unavailable.";
    }
    return "The HMI request could not be completed.";
  }
}
