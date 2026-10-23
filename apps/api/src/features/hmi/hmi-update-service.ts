import { randomUUID } from "node:crypto";
import type { HmiArtifactRecord, HmiUpdateJob, Panel, PanelTelemetry } from "../../types.js";
import type { Logger } from "../../services/logger.js";
import type { RuntimeStateStore } from "../runtime/runtime-state-store.js";

const MAX_PENDING_ACK_MS = 2 * 60 * 1000;
const MAX_UPLOAD_MS = 30 * 60 * 1000;
const EXPIRY_SCAN_INTERVAL_MS = 15 * 1000;
const JOB_ID_PATTERN = /^[0-9a-f-]{36}$/i;

export class HmiUpdateError extends Error {
  constructor(message: string, readonly statusCode: 409 = 409) {
    super(message);
    this.name = "HmiUpdateError";
  }
}

/** Tracks durable panel-specific HMI update attempts and publishes their state changes. */
export class HmiUpdateService {
  private expiryTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly runtimeState: RuntimeStateStore,
    private readonly publishJob: (job: HmiUpdateJob) => void,
    private readonly logger: Logger
  ) {}

  /** Starts server-side expiry handling so abandoned updates settle without browser polling. */
  start(): void {
    if (this.expiryTimer) return;
    void this.expireJobs();
    this.expiryTimer = setInterval(() => { void this.expireJobs(); }, EXPIRY_SCAN_INTERVAL_MS);
  }

  /** Stops background lifecycle work during graceful API shutdown. */
  close(): void {
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    this.expiryTimer = undefined;
  }

  /** Returns the retained history after expiring stale active jobs. */
  async listJobs(): Promise<HmiUpdateJob[]> {
    await this.expireJobs();
    return this.runtimeState.getHmiUpdateJobs();
  }

  /** Returns one update record for immediate REST responses. */
  getJob(jobId: string): HmiUpdateJob | undefined {
    return this.runtimeState.getHmiUpdateJobs().find((job) => job.id === jobId);
  }

  /** Creates a persisted update record before its MQTT command is published. */
  async begin(panel: Panel, artifact: HmiArtifactRecord, force: boolean, expiresAt: string, requestedBy?: string): Promise<HmiUpdateJob> {
    await this.expireJobs();
    const active = this.runtimeState.getHmiUpdateJobs().find((job) => job.panelId === panel.id && isActive(job.status));
    if (active) throw new HmiUpdateError(`An HMI update for ${panel.name} is already ${statusPhrase(active.status)}.`);

    const now = Date.now();
    const job: HmiUpdateJob = {
      id: randomUUID(),
      panelId: panel.id,
      panelName: panel.name,
      nodeName: panel.nodeName,
      artifactId: artifact.id,
      filename: artifact.filename,
      hmiVersion: artifact.sha256,
      status: "sending",
      force,
      requestedAt: now,
      updatedAt: now,
      expiresAt: Date.parse(expiresAt),
      ...(requestedBy ? { requestedBy } : {})
    };
    await this.save(job);
    return job;
  }

  /** Records broker publication unless an early device acknowledgement already advanced the job. */
  async markPublished(jobId: string): Promise<void> {
    const job = this.findJob(jobId);
    if (!job || job.status !== "sending") return;
    await this.update(job, { status: "sent", message: "Waiting for the panel to acknowledge the request." });
  }

  /** Marks an update as failed when its MQTT command could not be handed to the broker. */
  async markPublishFailed(jobId: string, message: string): Promise<void> {
    const job = this.findJob(jobId);
    if (!job || isTerminal(job.status)) return;
    await this.update(job, { status: "failed", message });
  }

  /** Validates and applies one firmware status event received over the panel's MQTT event topic. */
  async handlePanelReport(panel: Panel, payload: string, receivedAt: number): Promise<void> {
    const report = parsePanelReport(payload);
    if (!report) return;
    const job = this.findJob(report.jobId);
    if (!job || job.panelId !== panel.id || isTerminal(job.status)) return;

    if (report.status === "awaiting_confirmation") {
      if (job.status === "sending" || job.status === "sent" || job.status === "awaiting_confirmation") {
        await this.update(job, { status: "awaiting_confirmation", message: "Confirm the update on the panel to begin." }, receivedAt);
      }
      return;
    }
    if (report.status === "uploading") {
      await this.update(job, { status: "uploading", message: "The panel is updating its display." }, receivedAt);
      return;
    }
    if (report.status === "failed") {
      await this.update(job, { status: "failed", message: report.message || "The panel reported that the HMI update failed." }, receivedAt);
      return;
    }
    if (report.status === "cancelled") {
      await this.update(job, { status: "cancelled", message: report.message || "The panel update prompt was cancelled." }, receivedAt);
      return;
    }
    if (report.status === "succeeded") {
      if (report.version !== job.hmiVersion) {
        await this.update(job, { status: "failed", message: "The panel completed an update but reported a different HMI version." }, receivedAt);
        return;
      }
      await this.update(job, { status: "succeeded", message: "The panel reports the requested HMI version installed." }, receivedAt);
    }
  }

  /** Confirms a job from a heartbeat when its reported SHA-256 matches the requested artifact. */
  async observePanelPing(panel: Panel, telemetry: PanelTelemetry | null, receivedAt: number): Promise<void> {
    const reportedVersion = telemetry?.hmiVersion;
    if (!reportedVersion) return;
    const job = this.runtimeState.getHmiUpdateJobs().find((candidate) => candidate.panelId === panel.id
      && isActive(candidate.status)
      && candidate.hmiVersion === reportedVersion);
    if (!job) return;
    await this.update(job, { status: "succeeded", message: "The panel heartbeat confirms the requested HMI version." }, receivedAt);
  }

  private findJob(id: string): HmiUpdateJob | undefined {
    return this.runtimeState.getHmiUpdateJobs().find((job) => job.id === id);
  }

  private async update(job: HmiUpdateJob, update: Pick<HmiUpdateJob, "status" | "message">, updatedAt = Date.now()): Promise<void> {
    const next: HmiUpdateJob = {
      ...job,
      status: update.status,
      updatedAt,
      ...(update.message ? { message: update.message } : {})
    };
    await this.save(next);
  }

  private async save(job: HmiUpdateJob): Promise<void> {
    await this.runtimeState.upsertHmiUpdateJob(job);
    await this.runtimeState.flush();
    this.publishJob(job);
    this.logger.info("HMI update job changed.", {
      component: "hmi",
      jobId: job.id,
      panel: job.nodeName,
      artifactId: job.artifactId,
      status: job.status,
      hmiVersion: job.hmiVersion
    });
  }

  private async expireJobs(): Promise<void> {
    const now = Date.now();
    for (const job of this.runtimeState.getHmiUpdateJobs()) {
      if (job.status === "sending" && now - job.updatedAt >= MAX_PENDING_ACK_MS) {
        await this.update(job, { status: "timed_out", message: "The panel did not acknowledge the update request." }, now);
      } else if (job.status === "sent" && now - job.updatedAt >= MAX_PENDING_ACK_MS) {
        await this.update(job, { status: "timed_out", message: "The panel did not acknowledge the update request." }, now);
      } else if (job.status === "awaiting_confirmation" && now >= job.expiresAt) {
        await this.update(job, { status: "timed_out", message: "The panel did not start the update before its download link expired." }, now);
      } else if (job.status === "uploading" && now - job.updatedAt >= MAX_UPLOAD_MS) {
        await this.update(job, { status: "timed_out", message: "The panel did not report completion within 30 minutes." }, now);
      }
    }
  }
}

function parsePanelReport(payload: string): { jobId: string; status: "awaiting_confirmation" | "uploading" | "failed" | "cancelled" | "succeeded"; version?: string; message?: string } | null {
  let value: unknown;
  try { value = JSON.parse(payload) as unknown; } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const jobId = typeof record["job_id"] === "string" ? record["job_id"] : "";
  const status = record["status"];
  if (!JOB_ID_PATTERN.test(jobId) || !["awaiting_confirmation", "uploading", "failed", "cancelled", "succeeded"].includes(String(status))) return null;
  const version = typeof record["version"] === "string" && /^[0-9a-f]{64}$/i.test(record["version"]) ? record["version"].toLowerCase() : undefined;
  const message = typeof record["message"] === "string" ? record["message"].replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 160) : undefined;
  return { jobId, status: status as "awaiting_confirmation" | "uploading" | "failed" | "cancelled" | "succeeded", ...(version ? { version } : {}), ...(message ? { message } : {}) };
}

function isActive(status: HmiUpdateJob["status"]): boolean {
  return status === "sending" || status === "sent" || status === "awaiting_confirmation" || status === "uploading";
}

function isTerminal(status: HmiUpdateJob["status"]): boolean { return !isActive(status); }

function statusPhrase(status: HmiUpdateJob["status"]): string {
  return status === "uploading" ? "updating" : status === "awaiting_confirmation" ? "waiting for confirmation" : "in progress";
}
