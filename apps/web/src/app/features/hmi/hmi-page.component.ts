import { HttpErrorResponse } from "@angular/common/http";
import { Component, ElementRef, OnInit, signal, viewChild } from "@angular/core";
import { ManagerStore } from "../../manager-store.service";
import type { HmiArtifact, Panel } from "../../models";

/** Uploads a Nextion TFT and requests an HMI update on a selected registered panel. */
@Component({
  selector: "nspanel-hmi-page",
  standalone: true,
  templateUrl: "./hmi-page.component.html",
  styleUrl: "./hmi-page.component.css"
})
export class HmiPageComponent implements OnInit {
  readonly artifact = signal<HmiArtifact | null>(null);
  readonly selectedFile = signal<File | null>(null);
  readonly loading = signal(true);
  readonly uploading = signal(false);
  readonly updatingPanelId = signal("");
  readonly maxUploadBytes = signal(32 * 1024 * 1024);
  readonly fileInput = viewChild<ElementRef<HTMLInputElement>>("fileInput");

  /** Shares configured panels and API operations with the workspace. */
  constructor(readonly manager: ManagerStore) {}

  /** Loads the currently stored TFT metadata when the HMI workspace opens. */
  ngOnInit(): void { this.refresh(); }

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

  /** Sends a fresh temporary download URL to the selected panel over MQTT. */
  requestUpdate(panel: Panel): void {
    if (this.updatingPanelId() || !this.artifact() || !this.manager.mqtt().connected) return;
    this.updatingPanelId.set(panel.id);
    this.manager.requestHmiUpdate(panel.id).subscribe({
      next: ({ expiresAt }) => {
        this.updatingPanelId.set("");
        this.manager.inform(`Update prompt sent to ${panel.name}. Press UPDATE on the panel to begin; its download link expires at ${this.formatTimestamp(expiresAt)}.`);
      },
      error: (error: unknown) => {
        this.updatingPanelId.set("");
        this.manager.inform(this.errorMessage(error), "error");
      }
    });
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

  private errorMessage(error: unknown): string {
    if (error instanceof HttpErrorResponse) {
      const body = error.error as { error?: unknown } | null;
      if (typeof body?.error === "string") return body.error;
      return error.status ? `The HMI request failed (${error.status}).` : "The manager API is unavailable.";
    }
    return "The HMI request could not be completed.";
  }
}
