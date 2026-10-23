import { randomUUID } from "node:crypto";
import type { FirmwareArtifactRecord, FirmwareUpdateJob, Panel, PanelTelemetry } from "../../types.js";
import type { Logger } from "../../services/logger.js";
import type { RuntimeStateStore } from "../runtime/runtime-state-store.js";

const MAX_PENDING_ACK_MS = 2 * 60 * 1000;
const MAX_DOWNLOAD_MS = 30 * 60 * 1000;
const MAX_REBOOT_WAIT_MS = 10 * 60 * 1000;
const EXPIRY_SCAN_INTERVAL_MS = 15 * 1000;
const JOB_ID_PATTERN = /^[0-9a-f-]{36}$/i;

export class FirmwareUpdateError extends Error {
  constructor(message: string, readonly statusCode: 409 = 409) {
    super(message);
    this.name = "FirmwareUpdateError";
  }
}

/** Tracks durable manager-delivered firmware update attempts and device reports. */
export class FirmwareUpdateService {
  private expiryTimer?: ReturnType<typeof setInterval>;
  private readonly startingPanels = new Set<string>();
  private expiryRun?: Promise<void>;

  constructor(
    private readonly runtimeState: RuntimeStateStore,
    private readonly publishJob: (job: FirmwareUpdateJob) => void,
    private readonly logger: Logger
  ) {}

  /** Starts expiry handling so abandoned updates settle without browser polling. */
  start(): void {
    if (this.expiryTimer) return;
    void this.expireJobs();
    this.expiryTimer = setInterval(() => { void this.expireJobs(); }, EXPIRY_SCAN_INTERVAL_MS);
  }

  /** Stops lifecycle work during manager shutdown. */
  close(): void {
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    this.expiryTimer = undefined;
  }

  /** Returns persisted job state for the authenticated realtime snapshot. */
  async getJobsForSnapshot(): Promise<FirmwareUpdateJob[]> {
    await this.expireJobs();
    return this.runtimeState.getFirmwareUpdateJobs();
  }

  /** Returns one update record for immediate REST responses. */
  getJob(jobId: string): FirmwareUpdateJob | undefined {
    return this.runtimeState.getFirmwareUpdateJobs().find((job) => job.id === jobId);
  }

  /** Returns whether the panel currently has a non-terminal firmware update. */
  hasActiveJob(panelId: string): boolean {
    return this.runtimeState.getFirmwareUpdateJobs().some((job) => job.panelId === panelId && isActive(job.status));
  }

  /** Creates the durable record before the MQTT update command is published. */
  async begin(panel: Panel, artifact: FirmwareArtifactRecord, force: boolean, expiresAt: string, requestedBy?: string): Promise<FirmwareUpdateJob> {
    if (this.startingPanels.has(panel.id)) throw new FirmwareUpdateError(`A firmware update for ${panel.name} is already being requested.`);
    this.startingPanels.add(panel.id);
    try {
      await this.expireJobs();
      const active = this.runtimeState.getFirmwareUpdateJobs().find((job) => job.panelId === panel.id && isActive(job.status));
      if (active) throw new FirmwareUpdateError(`A firmware update for ${panel.name} is already ${statusPhrase(active.status)}.`);
      const now = Date.now();
      const job: FirmwareUpdateJob = {
        id: randomUUID(),
        panelId: panel.id,
        panelName: panel.name,
        nodeName: panel.nodeName,
        artifactId: artifact.id,
        filename: artifact.filename,
        firmwareVersion: artifact.version,
        status: "sending",
        force,
        requestedAt: now,
        updatedAt: now,
        expiresAt: Date.parse(expiresAt),
        ...(requestedBy ? { requestedBy } : {})
      };
      await this.save(job);
      return job;
    } finally {
      this.startingPanels.delete(panel.id);
    }
  }

  /** Records broker publication unless the panel has already acknowledged the job. */
  async markPublished(jobId: string): Promise<void> {
    const job = this.findJob(jobId);
    if (!job || job.status !== "sending") return;
    await this.update(job, { status: "sent", message: "Waiting for the panel to acknowledge the firmware request." });
  }

  /** Marks the job failed when the MQTT command could not be handed to the broker. */
  async markPublishFailed(jobId: string, message: string): Promise<void> {
    const job = this.findJob(jobId);
    if (!job || isTerminal(job.status)) return;
    await this.update(job, { status: "failed", message });
  }

  /** Applies a firmware lifecycle report and returns true when the requested version succeeds. */
  async handlePanelReport(panel: Panel, payload: string, receivedAt: number): Promise<boolean> {
    const report = parsePanelReport(payload);
    if (!report) return false;
    const job = this.findJob(report.jobId);
    if (!job || job.panelId !== panel.id || isTerminal(job.status)) return false;
    if (report.status === "awaiting_confirmation") {
      if (job.status === "sending" || job.status === "sent" || job.status === "awaiting_confirmation") {
        await this.update(job, { status: "awaiting_confirmation", message: "Confirm the firmware update on the panel." }, receivedAt);
      }
      return false;
    }
    if (report.status === "uploading") {
      await this.update(job, { status: "uploading", message: report.message || "The panel is downloading and installing firmware.", progress: report.progress }, receivedAt);
      return false;
    }
    if (report.status === "rebooting") {
      await this.update(job, { status: "rebooting", message: report.message || "Firmware installed; waiting for the panel to restart.", progress: report.progress ?? 100 }, receivedAt);
      return false;
    }
    if (report.status === "failed") {
      await this.update(job, { status: "failed", message: report.message || "The panel reported that the firmware update failed." }, receivedAt);
      return false;
    }
    if (report.status === "cancelled") {
      await this.update(job, { status: "cancelled", message: report.message || "The panel update prompt was cancelled." }, receivedAt);
      return false;
    }
    if (report.version !== job.firmwareVersion) {
      await this.update(job, { status: "failed", message: `The panel restarted with firmware ${report.version || "unknown"}, not the requested ${job.firmwareVersion}.` }, receivedAt);
      return false;
    }
    await this.update(job, { status: "succeeded", message: "The panel restarted with the requested firmware version.", progress: 100 }, receivedAt);
    return true;
  }

  /** Confirms a job from heartbeat telemetry and returns true when the requested version succeeds. */
  async observePanelPing(panel: Panel, telemetry: PanelTelemetry | null, receivedAt: number): Promise<boolean> {
    const reportedVersion = telemetry?.firmwareVersion;
    if (!reportedVersion) return false;
    const job = this.runtimeState.getFirmwareUpdateJobs().find((candidate) => candidate.panelId === panel.id
      && isActive(candidate.status)
      && candidate.firmwareVersion === reportedVersion);
    if (!job) return false;
    await this.update(job, { status: "succeeded", message: "The panel heartbeat confirms the requested firmware version.", progress: 100 }, receivedAt);
    return true;
  }

  private findJob(id: string): FirmwareUpdateJob | undefined {
    return this.runtimeState.getFirmwareUpdateJobs().find((job) => job.id === id);
  }

  private async update(job: FirmwareUpdateJob, patch: Partial<Pick<FirmwareUpdateJob, "status" | "message" | "progress">>, updatedAt = Date.now()): Promise<void> {
    const next: FirmwareUpdateJob = {
      ...job,
      ...patch,
      updatedAt,
      ...(patch.progress === undefined ? {} : { progress: patch.progress })
    };
    await this.save(next);
  }

  private async save(job: FirmwareUpdateJob): Promise<void> {
    await this.runtimeState.upsertFirmwareUpdateJob(job);
    await this.runtimeState.flush();
    this.publishJob(job);
    this.logger.info("Firmware update job changed.", {
      component: "firmware",
      jobId: job.id,
      panel: job.nodeName,
      artifactId: job.artifactId,
      version: job.firmwareVersion,
      status: job.status,
      ...(job.progress === undefined ? {} : { progress: String(job.progress) })
    });
  }

  private async expireJobs(): Promise<void> {
    if (this.expiryRun) return this.expiryRun;
    this.expiryRun = this.expireStaleJobs().finally(() => { this.expiryRun = undefined; });
    return this.expiryRun;
  }

  private async expireStaleJobs(): Promise<void> {
    const now = Date.now();
    for (const job of this.runtimeState.getFirmwareUpdateJobs()) {
      if ((job.status === "sending" || job.status === "sent") && now - job.updatedAt >= MAX_PENDING_ACK_MS) {
        await this.update(job, { status: "timed_out", message: "The panel did not acknowledge the firmware update request." }, now);
      } else if (job.status === "awaiting_confirmation" && now >= job.expiresAt) {
        await this.update(job, { status: "timed_out", message: "The panel did not start the firmware update before its download link expired." }, now);
      } else if (job.status === "uploading" && now - job.updatedAt >= MAX_DOWNLOAD_MS) {
        await this.update(job, { status: "timed_out", message: "The panel did not finish downloading and installing firmware within 30 minutes." }, now);
      } else if (job.status === "rebooting" && now - job.updatedAt >= MAX_REBOOT_WAIT_MS) {
        await this.update(job, { status: "timed_out", message: "The panel did not report back after installing firmware." }, now);
      }
    }
  }
}

type PanelReportStatus = "awaiting_confirmation" | "uploading" | "rebooting" | "failed" | "cancelled" | "succeeded";

function parsePanelReport(payload: string): { jobId: string; status: PanelReportStatus; version?: string; message?: string; progress?: number } | null {
  let value: unknown;
  try { value = JSON.parse(payload) as unknown; } catch { return null; }
  if (!isRecord(value)) return null;
  const jobId = typeof value["job_id"] === "string" ? value["job_id"] : "";
  const status = value["status"];
  if (!JOB_ID_PATTERN.test(jobId) || typeof status !== "string" || !["awaiting_confirmation", "uploading", "rebooting", "failed", "cancelled", "succeeded"].includes(status)) return null;
  const version = typeof value["version"] === "string" && /^[0-9A-Za-z._+-]{1,40}$/.test(value["version"]) ? value["version"] : undefined;
  const message = typeof value["message"] === "string" ? value["message"].replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 160) : undefined;
  const progress = typeof value["progress"] === "number" && Number.isInteger(value["progress"]) && value["progress"] >= 0 && value["progress"] <= 100 ? value["progress"] : undefined;
  return { jobId, status: status as PanelReportStatus, ...(version ? { version } : {}), ...(message ? { message } : {}), ...(progress === undefined ? {} : { progress }) };
}

function isActive(status: FirmwareUpdateJob["status"]): boolean {
  return status === "sending" || status === "sent" || status === "awaiting_confirmation" || status === "uploading" || status === "rebooting";
}

function isTerminal(status: FirmwareUpdateJob["status"]): boolean { return !isActive(status); }

function statusPhrase(status: FirmwareUpdateJob["status"]): string {
  return status === "uploading" ? "downloading" : status === "rebooting" ? "rebooting" : status === "awaiting_confirmation" ? "waiting for confirmation" : "in progress";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
