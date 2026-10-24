import { randomUUID } from "node:crypto";
import type { FirmwareArtifactRecord, FirmwareRollout, FirmwareUpdateJob, Panel, PanelTelemetry } from "../../types.js";
import type { Logger } from "../../services/logger.js";
import type { RuntimeStateStore } from "../runtime/runtime-state-store.js";
import type { ConfigStore } from "../../services/config-store.js";
import type { MqttRuntime } from "../../services/mqtt-runtime.js";
import type { FirmwareArtifactService } from "./firmware-artifact-service.js";

const MAX_PENDING_ACK_MS = 2 * 60 * 1000;
const MAX_DOWNLOAD_MS = 30 * 60 * 1000;
const MAX_REBOOT_WAIT_MS = 10 * 60 * 1000;
const MAX_CANARY_CONFIRMATION_MS = 30 * 60 * 1000;
const EXPIRY_SCAN_INTERVAL_MS = 15 * 1000;
const MAX_CANARY_HEARTBEAT_GAP_MS = 180 * 1000;
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
  private startingRollout = false;
  private expiryRun?: Promise<void>;
  private rolloutRun?: Promise<void>;

  constructor(
    private readonly runtimeState: RuntimeStateStore,
    private readonly publishJob: (job: FirmwareUpdateJob) => void,
    private readonly logger: Logger,
    private readonly store: ConfigStore,
    private readonly firmwareArtifacts: FirmwareArtifactService,
    private readonly mqttRuntime: MqttRuntime,
    private readonly publishRollout: (rollout: FirmwareRollout | null) => void
  ) {}

  /** Starts expiry handling so abandoned updates settle without browser polling. */
  start(): void {
    if (this.expiryTimer) return;
    void this.expireJobs();
    void this.progressRollout();
    this.expiryTimer = setInterval(() => {
      void this.expireJobs();
      void this.progressRollout();
    }, EXPIRY_SCAN_INTERVAL_MS);
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

  /** Returns the persisted rollout for realtime snapshots. */
  getRolloutForSnapshot(): FirmwareRollout | null { return this.runtimeState.getFirmwareRollout(); }

  /** Prevents a second manual canary from replacing an in-progress rollout. */
  hasActiveRollout(): boolean {
    const status = this.runtimeState.getFirmwareRollout()?.status;
    return this.startingRollout || status === "monitoring" || status === "updating";
  }

  /** Reserves the single rollout slot while a manual canary request is being prepared. */
  reserveRolloutStart(): boolean {
    if (this.startingRollout || this.hasActiveRollout()) return false;
    this.startingRollout = true;
    return true;
  }

  /** Releases an unused rollout reservation after an API request fails early. */
  releaseRolloutStart(): void { this.startingRollout = false; }

  /** Begins canary observation for the manually requested panel and snapshots opted-in recipients. */
  async startRollout(canaryJob: FirmwareUpdateJob, targetPanelIds: string[], stableHours: number): Promise<void> {
    if (!targetPanelIds.length) return;
    const status = this.runtimeState.getFirmwareRollout()?.status;
    if (status === "monitoring" || status === "updating") throw new FirmwareUpdateError("A staged firmware rollout is already active.");
    if (!this.startingRollout) this.startingRollout = true;
    try {
      const now = Date.now();
      const rollout: FirmwareRollout = {
        id: randomUUID(),
        artifactId: canaryJob.artifactId,
        firmwareVersion: canaryJob.firmwareVersion,
        canaryPanelId: canaryJob.panelId,
        canaryPanelName: canaryJob.panelName,
        startedAt: now,
        updatedAt: now,
        stableHours,
        status: "monitoring",
        canaryConfirmed: false,
        pendingPanelIds: [...new Set(targetPanelIds.filter((panelId) => panelId !== canaryJob.panelId))],
        message: `Waiting for ${canaryJob.panelName} to report firmware ${canaryJob.firmwareVersion}.`
      };
      if (rollout.pendingPanelIds.length) await this.saveRollout(rollout);
    } finally {
      this.startingRollout = false;
    }
  }

  /** Stops a rollout from scheduling more panels; an update already in progress is allowed to finish. */
  async cancelRollout(message = "Automatic firmware rollout disabled."): Promise<void> {
    const rollout = this.runtimeState.getFirmwareRollout();
    if (!rollout || (rollout.status !== "monitoring" && rollout.status !== "updating")) return;
    await this.saveRollout({ ...rollout, status: "cancelled", message, updatedAt: Date.now() });
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
    let confirmed = false;
    if (reportedVersion) {
      const job = this.runtimeState.getFirmwareUpdateJobs().find((candidate) => candidate.panelId === panel.id
      && isActive(candidate.status)
      && candidate.firmwareVersion === reportedVersion);
      if (job) {
        await this.update(job, { status: "succeeded", message: "The panel heartbeat confirms the requested firmware version.", progress: 100 }, receivedAt);
        confirmed = true;
      }
    }
    await this.observeCanaryHeartbeat(panel, telemetry, receivedAt);
    await this.progressRollout();
    return confirmed;
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
    await this.handleRolloutJobUpdate(next);
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

  private async observeCanaryHeartbeat(panel: Panel, telemetry: PanelTelemetry | null, receivedAt: number): Promise<void> {
    let rollout = this.runtimeState.getFirmwareRollout();
    if (!rollout || (rollout.status !== "monitoring" && rollout.status !== "updating") || panel.id !== rollout.canaryPanelId) return;
    const version = telemetry?.firmwareVersion;
    if (version !== rollout.firmwareVersion) {
      if (rollout.canaryConfirmed) await this.failRollout(rollout, `Canary ${rollout.canaryPanelName} stopped reporting ${rollout.firmwareVersion}; rollout stopped.`);
      return;
    }
    const uptimeSeconds = telemetry?.uptimeSeconds;
    if (typeof uptimeSeconds !== "number" || !Number.isFinite(uptimeSeconds) || uptimeSeconds < 0) return;
    const gap = rollout.lastHeartbeatAt === undefined ? 0 : receivedAt - rollout.lastHeartbeatAt;
    const rebooted = rollout.lastUptimeSeconds !== undefined && uptimeSeconds < rollout.lastUptimeSeconds - 1;
    const uptimeStopped = rollout.lastUptimeSeconds !== undefined && gap > 15_000 && uptimeSeconds <= rollout.lastUptimeSeconds;
    const interrupted = rollout.lastHeartbeatAt !== undefined && (gap > MAX_CANARY_HEARTBEAT_GAP_MS || rebooted || uptimeStopped);
    if (rollout.status === "updating" && interrupted) {
      await this.failRollout(rollout, `Canary ${rollout.canaryPanelName} rebooted or stopped reporting during rollout; remaining updates were stopped.`);
      return;
    }
    const stableSinceAt = rollout.stableSinceAt === undefined || interrupted ? receivedAt : rollout.stableSinceAt;
    rollout = {
      ...rollout,
      canaryConfirmed: true,
      stableSinceAt,
      lastHeartbeatAt: receivedAt,
      lastUptimeSeconds: uptimeSeconds,
      updatedAt: receivedAt,
      message: rollout.status !== "monitoring"
        ? rollout.message
        : interrupted
          ? `Canary stability restarted after a reboot or heartbeat gap. ${formatDuration(0)} of ${rollout.stableHours} hours observed.`
          : `Canary ${rollout.canaryPanelName} has been stable for ${formatDuration(receivedAt - stableSinceAt)} of ${rollout.stableHours} hours.`
    };
    await this.saveRollout(rollout);
  }

  private async handleRolloutJobUpdate(job: FirmwareUpdateJob): Promise<void> {
    const rollout = this.runtimeState.getFirmwareRollout();
    if (!rollout || (rollout.status !== "monitoring" && rollout.status !== "updating")) return;
    if (job.panelId === rollout.canaryPanelId) {
      if (rollout.status === "monitoring" && isTerminal(job.status) && job.status !== "succeeded") {
        await this.failRollout(rollout, `Canary update failed on ${job.panelName}; remaining panels were not updated.`);
      }
      return;
    }
    if (rollout.status !== "updating" || rollout.currentPanelId !== job.panelId) return;
    if (job.status === "succeeded") {
      await this.saveRollout({
        ...rollout,
        currentPanelId: undefined,
        updatedAt: Date.now(),
        message: `${job.panelName} confirmed firmware ${rollout.firmwareVersion}. Continuing with the next opted-in panel.`
      });
      void this.progressRollout();
    } else if (isTerminal(job.status)) {
      await this.failRollout(rollout, `Update failed on ${job.panelName}; the remaining rollout was stopped.`);
    }
  }

  private async progressRollout(): Promise<void> {
    if (this.rolloutRun) return this.rolloutRun;
    this.rolloutRun = this.progressRolloutState().finally(() => { this.rolloutRun = undefined; });
    return this.rolloutRun;
  }

  private async progressRolloutState(): Promise<void> {
    let rollout = this.runtimeState.getFirmwareRollout();
    if (!rollout || (rollout.status !== "monitoring" && rollout.status !== "updating")) return;
    const now = Date.now();
    if (rollout.status === "updating" && rollout.canaryConfirmed && rollout.lastHeartbeatAt !== undefined
      && now - rollout.lastHeartbeatAt > MAX_CANARY_HEARTBEAT_GAP_MS) {
      await this.failRollout(rollout, `Canary ${rollout.canaryPanelName} stopped reporting during rollout; remaining updates were stopped.`);
      return;
    }
    if (rollout.status === "monitoring") {
      if (!rollout.canaryConfirmed && now - rollout.startedAt > MAX_CANARY_CONFIRMATION_MS) {
        await this.failRollout(rollout, `Canary ${rollout.canaryPanelName} did not confirm firmware ${rollout.firmwareVersion}; remaining panels were not updated.`);
        return;
      }
      if (rollout.stableSinceAt !== undefined && rollout.lastHeartbeatAt !== undefined
        && now - rollout.lastHeartbeatAt > MAX_CANARY_HEARTBEAT_GAP_MS) {
        rollout = {
          ...rollout,
          stableSinceAt: undefined,
          updatedAt: now,
          message: "Canary heartbeat was interrupted; the stability timer will restart when it reconnects."
        };
        await this.saveRollout(rollout);
        return;
      }
      if (rollout.stableSinceAt === undefined || !rollout.canaryConfirmed
        || now - rollout.stableSinceAt < rollout.stableHours * 60 * 60 * 1000) return;
      rollout = {
        ...rollout,
        status: "updating",
        updatedAt: now,
        message: `Canary passed ${rollout.stableHours} hours of stable uptime. Starting the opted-in panels one at a time.`
      };
      await this.saveRollout(rollout);
    }
    if (rollout.status !== "updating") return;
    if (rollout.currentPanelId) {
      const currentPanelId = rollout.currentPanelId;
      const { artifactId, firmwareVersion } = rollout;
      const currentJob = this.runtimeState.getFirmwareUpdateJobs().find((job) => job.panelId === currentPanelId
        && job.artifactId === artifactId
        && job.firmwareVersion === firmwareVersion
        && job.requestedBy === "Automatic staged rollout");
      if (currentJob && isActive(currentJob.status)) return;
      if (currentJob?.status === "succeeded") {
        rollout = {
          ...rollout,
          currentPanelId: undefined,
          updatedAt: now,
          message: `${currentJob.panelName} confirmed firmware ${rollout.firmwareVersion}. Continuing with the next opted-in panel.`
        };
        await this.saveRollout(rollout);
      } else if (currentJob) {
        await this.failRollout(rollout, `Update failed on ${currentJob.panelName}; the remaining rollout was stopped.`);
        return;
      } else {
        rollout = {
          ...rollout,
          currentPanelId: undefined,
          pendingPanelIds: [currentPanelId, ...rollout.pendingPanelIds],
          updatedAt: now,
          message: "Resuming the rollout after the manager restarted before the panel update was created."
        };
        await this.saveRollout(rollout);
      }
    }
    if (!this.mqttRuntime.status().connected) {
      const message = "Waiting for the MQTT broker to reconnect before continuing the rollout.";
      if (rollout.message !== message) await this.saveRollout({ ...rollout, message, updatedAt: Date.now() });
      return;
    }

    let pendingIndex = 0;
    while (pendingIndex < rollout.pendingPanelIds.length) {
      const panelId: string = rollout.pendingPanelIds[pendingIndex]!;
      const panel: Panel | undefined = this.store.get().panels.find((candidate) => candidate.id === panelId);
      if (!panel || panel.autoUpdateFirmware !== true || panel.unifiedFirmware !== true) {
        rollout = { ...rollout, pendingPanelIds: removeIndex(rollout.pendingPanelIds, pendingIndex), updatedAt: Date.now() };
        await this.saveRollout(rollout);
        continue;
      }
      const connection = this.mqttRuntime.panelConnectionStatuses().find((candidate) => candidate.panelId === panel.id);
      if (connection?.status !== "online") {
        pendingIndex += 1;
        continue;
      }
      if (connection.telemetry?.firmwareVersion === rollout.firmwareVersion) {
        rollout = { ...rollout, pendingPanelIds: removeIndex(rollout.pendingPanelIds, pendingIndex), updatedAt: Date.now(), message: `${panel.name} already reports ${rollout.firmwareVersion}; skipping it.` };
        await this.saveRollout(rollout);
        continue;
      }
      const artifact = this.firmwareArtifacts.currentArtifact();
      if (!artifact || artifact.id !== rollout.artifactId) {
        await this.failRollout(rollout, "The rollout firmware package is no longer the active artifact. Upload it again and start a new rollout.");
        return;
      }
      const nextRollout = {
        ...rollout,
        pendingPanelIds: removeIndex(rollout.pendingPanelIds, pendingIndex),
        currentPanelId: panel.id,
        updatedAt: Date.now(),
        message: `Sending ${rollout.firmwareVersion} to ${panel.name}. Waiting for the panel to confirm it.`
      };
      await this.saveRollout(nextRollout);
      try {
        const download = await this.firmwareArtifacts.createDownloadUrl();
        if (download.artifact.id !== rollout.artifactId) throw new Error("The rollout firmware package changed before this panel was updated.");
        const job = await this.begin(panel, download.artifact, true, download.expiresAt, "Automatic staged rollout");
        if (!this.mqttRuntime.publishFirmwareUpdate(panel, download.url, download.artifact.md5, download.artifact.version, job.id, true)) {
          await this.markPublishFailed(job.id, "The MQTT broker disconnected before the automatic firmware request could be sent.");
          return;
        }
        await this.markPublished(job.id);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const current = this.runtimeState.getFirmwareRollout();
        if (current?.id === rollout.id && (current.status === "monitoring" || current.status === "updating")) {
          await this.failRollout(current, `Could not start the automatic update for ${panel.name}: ${detail}`);
        }
        return;
      }
      return;
    }
    if (rollout.pendingPanelIds.length) {
      const message = "Waiting for opted-in panels to come online before completing the rollout.";
      if (rollout.message !== message) await this.saveRollout({ ...rollout, message, updatedAt: Date.now() });
      return;
    }
    await this.saveRollout({ ...rollout, status: "completed", updatedAt: Date.now(), message: `All opted-in panels are running firmware ${rollout.firmwareVersion}.` });
  }

  private async failRollout(rollout: FirmwareRollout, message: string): Promise<void> {
    if (rollout.status !== "monitoring" && rollout.status !== "updating") return;
    await this.saveRollout({ ...rollout, status: "failed", updatedAt: Date.now(), message });
    this.logger.warn("Automatic firmware rollout stopped.", { component: "firmware", rolloutId: rollout.id, version: rollout.firmwareVersion, message });
  }

  private async saveRollout(rollout: FirmwareRollout): Promise<void> {
    await this.runtimeState.setFirmwareRollout(rollout);
    await this.runtimeState.flush();
    this.publishRollout(rollout);
    this.logger.info("Firmware rollout status changed.", {
      component: "firmware",
      rolloutId: rollout.id,
      version: rollout.firmwareVersion,
      status: rollout.status,
      canary: rollout.canaryPanelId,
      ...(rollout.currentPanelId ? { panelId: rollout.currentPanelId } : {})
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

function formatDuration(milliseconds: number): string {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours ? `${hours}h ${remainder}m` : `${remainder}m`;
}

function removeIndex(values: string[], index: number): string[] { return values.filter((_value, candidateIndex) => candidateIndex !== index); }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
