import express, { Router } from "express";
import { createReadStream } from "node:fs";
import type { Logger } from "../../services/logger.js";
import type { ConfigStore } from "../../services/config-store.js";
import type { MqttRuntime } from "../../services/mqtt-runtime.js";
import type { HmiUpdateService } from "../hmi/hmi-update-service.js";
import { FirmwareArtifactError, FirmwareArtifactService, MAX_FIRMWARE_UPLOAD_BYTES } from "./firmware-artifact-service.js";
import { FirmwareUpdateError, FirmwareUpdateService } from "./firmware-update-service.js";
import { panelBootstrapTopicRoot } from "../../domain/panel-topics.js";
import type { CoreDumpStore } from "./core-dump-store.js";

/** Creates authenticated firmware upload/update APIs and the public capability download endpoint. */
export function createFirmwareRouter(
  firmwareService: FirmwareArtifactService,
  firmwareUpdateService: FirmwareUpdateService,
  hmiUpdateService: HmiUpdateService,
  store: ConfigStore,
  mqttRuntime: MqttRuntime,
  logger: Logger,
  coreDumpStore: CoreDumpStore
): Router {
  const router = Router();

  router.get("/", (_request, response) => response.json({ artifact: firmwareService.currentArtifact(), maxUploadBytes: MAX_FIRMWARE_UPLOAD_BYTES }));

  router.put("/rollout-settings", async (request, response) => {
    const enabled = request.body?.enabled;
    const stableHours = request.body?.stableHours;
    if (typeof enabled !== "boolean" || typeof stableHours !== "number" || !Number.isInteger(stableHours) || stableHours < 1 || stableHours > 24) {
      return response.status(400).json({ error: "Enablement must be boolean and the canary stability period must be a whole number from 1 to 24 hours." });
    }
    const firmwareRollout = { enabled, stableHours };
    await store.update((config) => { config.firmwareRollout = firmwareRollout; }, {
      actor: request.authUser?.email ?? "unknown",
      summary: "Firmware rollout settings changed"
    });
    if (!enabled) await firmwareUpdateService.cancelRollout("Automatic staged rollout disabled by the administrator.");
    response.json({ firmwareRollout });
  });

  router.post("/rollout/cancel", async (_request, response) => {
    const rollout = await firmwareUpdateService.cancelRollout("Staged firmware rollout cancelled by the administrator.");
    response.json({ rollout });
  });

  router.post("/panels/:panelId/stage-rollout", async (request, response, next) => {
    const config = store.get();
    const panel = config.panels.find((item) => item.id === request.params.panelId);
    if (!panel) return response.status(404).json({ error: "Panel not found." });
    if (!config.firmwareRollout.enabled) {
      return response.status(409).json({ error: "Enable automatic firmware rollout before staging a canary." });
    }
    if (panel.unifiedFirmware !== true) {
      return response.status(409).json({ error: "Only a panel running the unified firmware can be used as a rollout canary." });
    }
    if (firmwareUpdateService.hasActiveRollout()) {
      return response.status(409).json({ error: "A staged firmware rollout is already active." });
    }
    if (firmwareUpdateService.hasActiveJob(panel.id)) {
      return response.status(409).json({ error: `Wait for the firmware update on ${panel.name} to finish before staging it as a canary.` });
    }

    const artifact = firmwareService.currentArtifact();
    if (!artifact) return response.status(409).json({ error: "Upload a firmware package before staging a rollout." });
    const canaryStatus = mqttRuntime.panelConnectionStatuses().find((status) => status.panelId === panel.id);
    const telemetry = canaryStatus?.telemetry;
    if (canaryStatus?.status !== "online" || !telemetry || telemetry.firmwareVersion !== artifact.version
      || typeof telemetry.uptimeSeconds !== "number" || !Number.isFinite(telemetry.uptimeSeconds)) {
      return response.status(409).json({ error: `Wait for ${panel.name} to report the uploaded firmware version and uptime before staging it as a canary.` });
    }
    if (Date.now() - telemetry.reportedAt > 180_000) {
      return response.status(409).json({ error: `Wait for a fresh heartbeat from ${panel.name} before staging it as a canary.` });
    }

    const targetPanelIds = config.panels
      .filter((candidate) => candidate.id !== panel.id && candidate.autoUpdateFirmware === true && candidate.unifiedFirmware === true)
      .map((candidate) => candidate.id);
    if (!targetPanelIds.length) {
      return response.status(409).json({ error: "Mark at least one other unified panel for automatic rollout first." });
    }

    try {
      const rollout = await firmwareUpdateService.stageCurrentCanary(panel, artifact, targetPanelIds, config.firmwareRollout.stableHours, telemetry);
      logger.info("Firmware rollout staged from a panel already running the uploaded version.", {
        component: "firmware",
        rolloutId: rollout.id,
        panel: panel.name,
        version: artifact.version,
        targetCount: String(targetPanelIds.length),
        requestedBy: request.authUser?.email ?? "unknown"
      });
      response.status(201).json({ rollout });
    } catch (error) {
      if (error instanceof FirmwareUpdateError) response.status(error.statusCode).json({ error: error.message });
      else next(error);
    }
  });

  router.get("/panels/:panelId/crash-dump", (request, response) => {
    const panel = store.get().panels.find((item) => item.id === request.params.panelId);
    if (!panel) return response.status(404).json({ error: "Panel not found." });
    response.json({ dump: coreDumpStore.latest(panel.id) ?? null });
  });

  router.get("/panels/:panelId/crash-dump/download", (request, response, next) => {
    const panel = store.get().panels.find((item) => item.id === request.params.panelId);
    if (!panel) return response.status(404).json({ error: "Panel not found." });
    const stored = coreDumpStore.fileFor(panel.id);
    if (!stored) return response.status(404).json({ error: "This panel has no captured crash dump." });

    const safeNodeName = panel.nodeName.replace(/[^a-zA-Z0-9_-]/g, "-");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Type", "application/octet-stream");
    response.setHeader("Content-Disposition", `attachment; filename="nspanel-${safeNodeName}-${stored.record.dumpId}.bin"`);
    response.setHeader("Content-Length", String(stored.record.sizeBytes));
    const stream = createReadStream(stored.filePath);
    response.on("close", () => { if (!response.writableEnded) stream.destroy(); });
    response.on("finish", () => logger.info("Panel crash dump downloaded.", {
      component: "firmware",
      panel: panel.name,
      dumpId: stored.record.dumpId,
      requestedBy: request.authUser?.email ?? "unknown"
    }));
    stream.on("error", (error) => {
      if (response.headersSent) response.destroy(error);
      else next(error);
    });
    stream.pipe(response);
  });

  router.post("/upload", express.raw({ type: "application/octet-stream", limit: MAX_FIRMWARE_UPLOAD_BYTES }), async (request, response, next) => {
    try {
      if (firmwareUpdateService.hasActiveRollout()) {
        return response.status(409).json({ error: "A staged firmware rollout is active. Wait for it to finish before replacing the firmware package." });
      }
      if (!Buffer.isBuffer(request.body)) return response.status(415).json({ error: "Upload the versioned firmware package as application/octet-stream." });
      const artifact = await firmwareService.upload(
        request.body,
        decodeHeader(request.get("x-firmware-filename") ?? ""),
        decodeHeader(request.get("x-firmware-version") ?? "")
      );
      logger.info("Firmware artifact uploaded.", {
        component: "firmware",
        artifactId: artifact.id,
        filename: artifact.filename,
        size: String(artifact.size),
        version: artifact.version,
        md5: artifact.md5,
        requestedBy: request.authUser?.email ?? "unknown"
      });
      response.status(201).json({ artifact });
    } catch (error) {
      if (error instanceof FirmwareArtifactError) response.status(error.statusCode).json({ error: error.message });
      else next(error);
    }
  });

  router.post("/panels/:panelId/update", async (request, response, next) => {
    const forceValue: unknown = request.body?.force;
    if (forceValue !== undefined && typeof forceValue !== "boolean") return response.status(400).json({ error: "The force option must be a boolean." });
    const force = forceValue === true;
    const panel = store.get().panels.find((item) => item.id === request.params.panelId);
    if (!panel) return response.status(404).json({ error: "Panel not found." });
    if (!mqttRuntime.status().connected) return response.status(503).json({ error: "The MQTT broker is not connected." });
    if (hmiUpdateService.hasActiveJob(panel.id)) return response.status(409).json({ error: `An HMI update for ${panel.name} is already in progress.` });

    const config = store.get();
    const activeArtifact = firmwareService.currentArtifact();
    const canaryVersion = mqttRuntime.panelConnectionStatuses().find((status) => status.panelId === panel.id)?.telemetry?.firmwareVersion;
    const canaryNeedsUpdate = Boolean(activeArtifact && canaryVersion !== activeArtifact.version);
    const rolloutTargets = config.firmwareRollout.enabled && panel.unifiedFirmware === true && canaryNeedsUpdate
      ? config.panels.filter((candidate) => candidate.id !== panel.id && candidate.autoUpdateFirmware === true && candidate.unifiedFirmware === true).map((candidate) => candidate.id)
      : [];
    if (firmwareUpdateService.hasActiveRollout()) {
      return response.status(409).json({ error: "A staged firmware rollout is already active. Wait for it to finish before starting another canary update." });
    }
    const rolloutReserved = rolloutTargets.length > 0;
    if (rolloutReserved && !firmwareUpdateService.reserveRolloutStart()) {
      return response.status(409).json({ error: "Another firmware rollout is being started. Try again in a moment." });
    }

    try {
      const download = await firmwareService.createDownloadUrl();
      const topic = `${panelBootstrapTopicRoot(panel)}/cmnd/updatefirmware`;
      const job = await firmwareUpdateService.begin(panel, download.artifact, force, download.expiresAt, request.authUser?.email);
      if (rolloutTargets.length) await firmwareUpdateService.startRollout(job, rolloutTargets, config.firmwareRollout.stableHours);
      if (!mqttRuntime.publishFirmwareUpdate(panel, download.url, download.artifact.md5, download.artifact.version, job.id, force)) {
        await firmwareUpdateService.markPublishFailed(job.id, "The MQTT broker disconnected before the firmware request could be sent.");
        return response.status(503).json({ error: "The MQTT broker disconnected before the firmware request could be sent.", job: firmwareUpdateService.getJob(job.id) });
      }
      await firmwareUpdateService.markPublished(job.id);
      logger.info("Firmware update request published.", {
        component: "firmware",
        panel: panel.nodeName,
        artifactId: download.artifact.id,
        jobId: job.id,
        version: download.artifact.version,
        force: String(force),
        grantExpiresAt: download.expiresAt,
        requestedBy: request.authUser?.email ?? "unknown"
      });
      response.json({
        published: true,
        panel: { id: panel.id, name: panel.name },
        topic,
        expiresAt: download.expiresAt,
        firmwareVersion: download.artifact.version,
        job: firmwareUpdateService.getJob(job.id) ?? job
      });
    } catch (error) {
      if (error instanceof FirmwareArtifactError) response.status(error.statusCode).json({ error: error.message });
      else if (error instanceof FirmwareUpdateError) response.status(error.statusCode).json({ error: error.message });
      else next(error);
    } finally {
      if (rolloutReserved) firmwareUpdateService.releaseRolloutStart();
    }
  });

  return router;
}

/** Creates the unauthenticated, capability-URL endpoint fetched by panel firmware. */
export function createFirmwareDownloadRouter(firmwareService: FirmwareArtifactService, logger: Logger): Router {
  const router = Router();

  router.head("/download/:token", async (request, response, next) => {
    try {
      const download = await firmwareService.resolveDownload(request.params.token);
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      if (!download) return response.status(404).end();
      response.setHeader("Content-Type", "application/octet-stream");
      response.setHeader("Content-Length", String(download.artifact.size));
      response.setHeader("Content-Disposition", "attachment; filename=firmware.bin");
      response.end();
    } catch (error) { next(error); }
  });

  router.get("/download/:token", async (request, response, next) => {
    try {
      const download = await firmwareService.resolveDownload(request.params.token);
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      if (!download) return response.status(404).json({ error: "This firmware download link is invalid or has expired." });
      response.setHeader("Content-Type", "application/octet-stream");
      response.setHeader("Content-Disposition", "attachment; filename=firmware.bin");
      response.setHeader("Content-Length", String(download.artifact.size));
      const stream = createReadStream(download.filePath);
      response.on("close", () => { if (!response.writableEnded) stream.destroy(); });
      response.on("finish", () => logger.info("Firmware binary downloaded by a panel.", {
        component: "firmware",
        artifactId: download.artifact.id,
        version: download.artifact.version,
        size: String(download.artifact.size)
      }));
      stream.on("error", (error) => {
        if (response.headersSent) response.destroy(error);
        else next(error);
      });
      stream.pipe(response);
    } catch (error) { next(error); }
  });

  return router;
}

function decodeHeader(value: string): string {
  try { return decodeURIComponent(value); }
  catch { return ""; }
}
