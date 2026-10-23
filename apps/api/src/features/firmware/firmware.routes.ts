import express, { Router } from "express";
import { createReadStream } from "node:fs";
import type { Logger } from "../../services/logger.js";
import type { ConfigStore } from "../../services/config-store.js";
import type { MqttRuntime } from "../../services/mqtt-runtime.js";
import type { HmiUpdateService } from "../hmi/hmi-update-service.js";
import { FirmwareArtifactError, FirmwareArtifactService, MAX_FIRMWARE_UPLOAD_BYTES } from "./firmware-artifact-service.js";
import { FirmwareUpdateError, FirmwareUpdateService } from "./firmware-update-service.js";
import { panelBootstrapTopicRoot } from "../../domain/panel-topics.js";

/** Creates authenticated firmware upload/update APIs and the public capability download endpoint. */
export function createFirmwareRouter(
  firmwareService: FirmwareArtifactService,
  firmwareUpdateService: FirmwareUpdateService,
  hmiUpdateService: HmiUpdateService,
  store: ConfigStore,
  mqttRuntime: MqttRuntime,
  logger: Logger
): Router {
  const router = Router();

  router.get("/", (_request, response) => response.json({ artifact: firmwareService.currentArtifact(), maxUploadBytes: MAX_FIRMWARE_UPLOAD_BYTES }));

  router.post("/upload", express.raw({ type: "application/octet-stream", limit: MAX_FIRMWARE_UPLOAD_BYTES }), async (request, response, next) => {
    try {
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

    try {
      const download = await firmwareService.createDownloadUrl();
      const topic = `${panelBootstrapTopicRoot(panel)}/cmnd/updatefirmware`;
      const job = await firmwareUpdateService.begin(panel, download.artifact, force, download.expiresAt, request.authUser?.email);
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
