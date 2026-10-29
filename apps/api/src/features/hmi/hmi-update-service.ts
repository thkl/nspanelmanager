import { randomUUID } from "node:crypto";
import type { HmiArtifactRecord, HmiRollout, HmiUpdateJob, Panel, PanelTelemetry } from "../../types.js";
import type { Logger } from "../../services/logger.js";
import type { ConfigStore } from "../../services/config-store.js";
import type { MqttRuntime } from "../../services/mqtt-runtime.js";
import type { HmiArtifactService } from "./hmi-artifact-service.js";
import type { RuntimeStateStore } from "../runtime/runtime-state-store.js";

const MAX_PENDING_ACK_MS = 2 * 60 * 1000;
const MAX_UPLOAD_MS = 30 * 60 * 1000;
const EXPIRY_SCAN_INTERVAL_MS = 15 * 1000;
const JOB_ID_PATTERN = /^[0-9a-f-]{36}$/i;

/** Carries a safe HTTP status for expected HMI update conflicts and validation failures. */
export class HmiUpdateError extends Error {
  constructor(message: string, readonly statusCode: 409 = 409) {
    // Routes map this domain error without inferring the failure from message text.
    super(message);
    this.name = "HmiUpdateError";
  }
}

/** Tracks durable panel-specific HMI update attempts and publishes their state changes. */
export class HmiUpdateService {
  private expiryTimer?: ReturnType<typeof setInterval>;
  private readonly startingPanels = new Set<string>();
  private expiryRun?: Promise<void>;
  private startingRollout = false;
  private artifactUploadInProgress = false;

  constructor(
    private readonly runtimeState: RuntimeStateStore,
    private readonly publishJob: (job: HmiUpdateJob) => void,
    private readonly publishRollout: (rollout: HmiRollout | null) => void,
    private readonly logger: Logger,
    private readonly store: ConfigStore,
    private readonly artifacts: HmiArtifactService,
    private readonly mqttRuntime: MqttRuntime
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

  /** Returns persisted update states for the initial realtime snapshot after settling stale jobs. */
  async getJobsForSnapshot(): Promise<HmiUpdateJob[]> {
    await this.expireJobs();
    return this.runtimeState.getHmiUpdateJobs();
  }

  /** Returns one update record for immediate REST responses. */
  getJob(jobId: string): HmiUpdateJob | undefined {
    return this.runtimeState.getHmiUpdateJobs().find((job) => job.id === jobId);
  }

  /** Returns the persisted rollout state for the initial WebSocket snapshot. */
  getRolloutForSnapshot(): HmiRollout | null {
    return this.runtimeState.getHmiRollout();
  }

  /** Indicates whether a canary-first rollout currently owns the HMI update queue. */
  hasActiveRollout(): boolean {
    return this.startingRollout || this.runtimeState.getHmiRollout()?.status === "updating";
  }

  /** Reserves the single staged rollout slot while its first panel job is created. */
  reserveRolloutStart(): boolean {
    if (this.hasActiveRollout() || this.artifactUploadInProgress) return false;
    this.startingRollout = true;
    return true;
  }

  /** Releases the rollout reservation when request validation or publication fails. */
  releaseRolloutStart(): void {
    this.startingRollout = false;
  }

  /** Prevents a new HMI upload from racing with a staged rollout's artifact selection. */
  reserveArtifactUpload(): boolean {
    if (this.hasActiveRollout() || this.artifactUploadInProgress) return false;
    this.artifactUploadInProgress = true;
    return true;
  }

  /** Releases the upload lock after the artifact has been saved or rejected. */
  releaseArtifactUpload(): void {
    this.artifactUploadInProgress = false;
  }

  /** Begins a sequential rollout, waiting for this canary job before any target is sent. */
  async startRollout(canaryJob: HmiUpdateJob, targetPanelIds: string[], force: boolean): Promise<HmiRollout> {
    if (!this.startingRollout) throw new HmiUpdateError("Reserve the staged HMI rollout before starting it.");
    const pendingPanelIds = [...new Set(targetPanelIds.filter((panelId) => panelId !== canaryJob.panelId))];
    if (pendingPanelIds.length === 0) throw new HmiUpdateError("Choose at least one target panel after the canary.");
    const now = Date.now();
    const rollout: HmiRollout = {
      id: randomUUID(),
      artifactId: canaryJob.artifactId,
      hmiVersion: canaryJob.hmiVersion,
      canaryPanelId: canaryJob.panelId,
      canaryPanelName: canaryJob.panelName,
      currentPanelId: canaryJob.panelId,
      currentJobId: canaryJob.id,
      pendingPanelIds,
      force,
      status: "updating",
      startedAt: now,
      updatedAt: now,
      message: `Waiting for ${canaryJob.panelName} to confirm HMI ${canaryJob.hmiVersion.slice(0, 12)}.`
    };
    await this.saveRollout(rollout, true);
    this.startingRollout = false;
    return rollout;
  }

  /** Stops the queue while allowing the current panel update to finish. */
  async cancelRollout(): Promise<HmiRollout | null> {
    const rollout = this.runtimeState.getHmiRollout();
    if (!rollout || rollout.status !== "updating") return rollout;
    const cancelled: HmiRollout = {
      ...rollout,
      status: "cancelled",
      updatedAt: Date.now(),
      message: "Staged HMI rollout cancelled. The current panel update may finish; queued panels will not be updated."
    };
    await this.saveRollout(cancelled);
    return this.runtimeState.getHmiRollout();
  }

  /** Returns whether the panel is waiting on or performing an HMI update. */
  hasActiveJob(panelId: string): boolean {
    return this.runtimeState.getHmiUpdateJobs().some((job) => job.panelId === panelId && isActive(job.status));
  }

  /** Creates a persisted update record before its MQTT command is published. */
  async begin(panel: Panel, artifact: HmiArtifactRecord, force: boolean, expiresAt: string, requestedBy?: string): Promise<HmiUpdateJob> {
    if (this.startingPanels.has(panel.id)) throw new HmiUpdateError(`An HMI update for ${panel.name} is already being requested.`);
    this.startingPanels.add(panel.id);
    try {
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
    } finally {
      this.startingPanels.delete(panel.id);
    }
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
    // A valid job ID is insufficient by itself; the report must belong to this panel's active attempt.
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
    await this.handleRolloutJobUpdate(next);
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

  private async handleRolloutJobUpdate(job: HmiUpdateJob): Promise<void> {
    let rollout = this.runtimeState.getHmiRollout();
    if (!rollout || rollout.status !== "updating" || rollout.currentJobId !== job.id || isActive(job.status)) return;
    if (job.status !== "succeeded") {
      await this.failRollout(rollout, `HMI rollout stopped because ${job.panelName} ${statusPhrase(job.status)}: ${job.message ?? job.status}.`);
      return;
    }

    if (rollout.pendingPanelIds.length === 0) {
      await this.saveRollout({
        ...rollout,
        status: "completed",
        updatedAt: Date.now(),
        message: `The canary and all selected panels report HMI ${rollout.hmiVersion.slice(0, 12)}.`
      });
      return;
    }

    const nextPanelId = rollout.pendingPanelIds[0];
    const panel = this.store.get().panels.find((candidate) => candidate.id === nextPanelId);
    if (!panel) {
      await this.failRollout(rollout, "HMI rollout stopped because a queued panel was removed from configuration.");
      return;
    }
    const artifact = this.artifacts.currentArtifact();
    if (!artifact || artifact.id !== rollout.artifactId) {
      await this.failRollout(rollout, "The HMI artifact changed or is unavailable. Upload the intended TFT and start a new rollout.");
      return;
    }
    if (!isArtifactCompatibleWithPanel(artifact, panel)) {
      await this.failRollout(rollout, `HMI rollout stopped because ${panel.name} is not compatible with the uploaded TFT.`);
      return;
    }
    if (!this.mqttRuntime.status().connected) {
      await this.failRollout(rollout, "HMI rollout stopped because the MQTT broker is disconnected.");
      return;
    }
    if (this.hasActiveJob(panel.id)) {
      await this.failRollout(rollout, `HMI rollout stopped because ${panel.name} already has another HMI update in progress.`);
      return;
    }

    try {
      const download = await this.artifacts.createDownloadUrl();
      if (download.artifact.id !== rollout.artifactId) throw new Error("The uploaded HMI artifact changed before this panel was updated.");
      const job = await this.begin(panel, download.artifact, rollout.force, download.expiresAt, "Staged HMI rollout");
      rollout = {
        ...rollout,
        currentPanelId: panel.id,
        currentJobId: job.id,
        pendingPanelIds: rollout.pendingPanelIds.slice(1),
        updatedAt: Date.now(),
        message: `Sent HMI ${rollout.hmiVersion.slice(0, 12)} to ${panel.name}; waiting for confirmation.`
      };
      await this.saveRollout(rollout);
      if (!this.isCurrentActiveRollout(rollout.id)) return;
      if (!this.mqttRuntime.publishHmiUpdate(panel, download.url, download.artifact.sha256, job.id, rollout.force)) {
        await this.markPublishFailed(job.id, "The MQTT broker disconnected before the staged HMI request could be sent.");
        return;
      }
      await this.markPublished(job.id);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.failRollout(rollout, `Could not start the HMI update for ${panel.name}: ${detail}`);
    }
  }

  private async reconcileRollout(): Promise<void> {
    const rollout = this.runtimeState.getHmiRollout();
    if (!rollout || rollout.status !== "updating" || !rollout.currentJobId) return;
    const job = this.findJob(rollout.currentJobId);
    if (!job || isActive(job.status)) return;
    if (job.status === "succeeded" && rollout.pendingPanelIds.length > 0 && !this.mqttRuntime.status().connected) return;
    await this.handleRolloutJobUpdate(job);
  }

  private async failRollout(rollout: HmiRollout, message: string): Promise<void> {
    if (rollout.status !== "updating") return;
    await this.saveRollout({ ...rollout, status: "failed", updatedAt: Date.now(), message });
    this.logger.warn("Staged HMI rollout stopped.", {
      component: "hmi",
      rolloutId: rollout.id,
      hmiVersion: rollout.hmiVersion,
      message
    });
  }

  private isCurrentActiveRollout(rolloutId: string): boolean {
    const current = this.runtimeState.getHmiRollout();
    return current?.id === rolloutId && current.status === "updating";
  }

  private async saveRollout(rollout: HmiRollout, replaceTerminal = false): Promise<void> {
    const current = this.runtimeState.getHmiRollout();
    if (current && current.id !== rollout.id && (!replaceTerminal || current.status === "updating")) return;
    if (current?.id === rollout.id && current.status !== "updating" && rollout.status === "updating") return;
    await this.runtimeState.setHmiRollout(rollout);
    await this.runtimeState.flush();
    const persisted = this.runtimeState.getHmiRollout();
    if (!persisted || persisted.id !== rollout.id || persisted.updatedAt !== rollout.updatedAt || persisted.status !== rollout.status) return;
    this.publishRollout(rollout);
    this.logger.info("Staged HMI rollout status changed.", {
      component: "hmi",
      rolloutId: rollout.id,
      hmiVersion: rollout.hmiVersion,
      status: rollout.status,
      currentPanelId: rollout.currentPanelId ?? ""
    });
  }

  private async expireJobs(): Promise<void> {
    if (this.expiryRun) return this.expiryRun;
    this.expiryRun = this.expireStaleJobs()
      .then(() => this.reconcileRollout())
      .finally(() => { this.expiryRun = undefined; });
    return this.expiryRun;
  }

  private async expireStaleJobs(): Promise<void> {
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

function isArtifactCompatibleWithPanel(artifact: HmiArtifactRecord, panel: Panel): boolean {
  const profile = panel.unifiedFirmware === true ? "unified" : "legacy";
  return artifact.compatibleProfiles.includes(profile);
}

function statusPhrase(status: HmiUpdateJob["status"]): string {
  switch (status) {
    case "uploading": return "was updating";
    case "awaiting_confirmation": return "was waiting for confirmation";
    case "failed": return "failed";
    case "cancelled": return "was cancelled";
    case "timed_out": return "timed out";
    case "succeeded": return "succeeded";
    case "sending":
    case "sent": return "was still in progress";
  }
}
