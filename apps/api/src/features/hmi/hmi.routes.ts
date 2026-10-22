import express, { Router } from "express";
import { createReadStream } from "node:fs";
import type { Logger } from "../../services/logger.js";
import type { ConfigStore } from "../../services/config-store.js";
import type { MqttRuntime } from "../../services/mqtt-runtime.js";
import { HmiArtifactError, HmiArtifactService, MAX_HMI_FILE_BYTES } from "./hmi-artifact-service.js";

/** Creates protected HMI upload and panel update endpoints. */
export function createHmiRouter(hmiService: HmiArtifactService, store: ConfigStore, mqttRuntime: MqttRuntime, logger: Logger): Router {
  const router = Router();

  router.get("/", (_request, response) => response.json({ artifact: hmiService.currentArtifact(), maxUploadBytes: MAX_HMI_FILE_BYTES }));

  router.post("/upload", express.raw({ type: "application/octet-stream", limit: MAX_HMI_FILE_BYTES }), async (request, response, next) => {
    try {
      if (!Buffer.isBuffer(request.body)) return response.status(415).json({ error: "Upload the TFT file as application/octet-stream." });
      const artifact = await hmiService.upload(request.body, decodeFilenameHeader(request.get("x-hmi-filename") ?? ""));
      logger.info("HMI artifact uploaded.", {
        component: "hmi",
        artifactId: artifact.id,
        size: String(artifact.size),
        sha256: artifact.sha256,
        requestedBy: request.authUser?.email ?? "unknown"
      });
      response.status(201).json({ artifact });
    } catch (error) {
      if (error instanceof HmiArtifactError) response.status(error.statusCode).json({ error: error.message });
      else next(error);
    }
  });

  router.post("/panels/:panelId/update", async (request, response, next) => {
    const panelId = request.params.panelId;
    const panel = store.get().panels.find((item) => item.id === panelId);
    if (!panel) return response.status(404).json({ error: "Panel not found." });
    if (!hmiService.currentArtifact()) return response.status(409).json({ error: "Upload an HMI file before requesting a panel update." });
    if (!mqttRuntime.status().connected) return response.status(503).json({ error: "The MQTT broker is not connected." });

    try {
      const download = await hmiService.createDownloadUrl();
      const topic = `${panel.nodeName}/cmnd/updatehmi`;
      if (!mqttRuntime.publishHmiUpdate(panel, download.url)) return response.status(503).json({ error: "The MQTT broker disconnected before the update request could be sent." });
      logger.info("HMI update request published.", {
        component: "hmi",
        panel: panel.nodeName,
        artifactId: hmiService.currentArtifact()?.id ?? "unknown",
        grantExpiresAt: download.expiresAt,
        requestedBy: request.authUser?.email ?? "unknown"
      });
      response.json({ published: true, panel: { id: panel.id, name: panel.name }, topic, expiresAt: download.expiresAt });
    } catch (error) {
      if (error instanceof HmiArtifactError) response.status(error.statusCode).json({ error: error.message });
      else next(error);
    }
  });

  return router;
}

function decodeFilenameHeader(value: string): string {
  try { return decodeURIComponent(value); }
  catch { return ""; }
}

/** Creates the unauthenticated, capability-URL endpoint fetched directly by panels. */
export function createHmiDownloadRouter(hmiService: HmiArtifactService, logger: Logger): Router {
  const router = Router();

  router.get("/download/:token", async (request, response, next) => {
    try {
      const download = await hmiService.resolveDownload(request.params.token);
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      if (!download) return response.status(404).json({ error: "This HMI download link is invalid or has expired." });

      response.setHeader("Content-Type", "application/octet-stream");
      response.setHeader("Content-Length", String(download.artifact.size));
      response.setHeader("Content-Disposition", "attachment; filename=\"hmi.tft\"");
      const stream = createReadStream(download.filePath);
      response.on("close", () => { if (!response.writableEnded) stream.destroy(); });
      response.on("finish", () => logger.info("HMI artifact downloaded by a panel.", {
        component: "hmi",
        artifactId: download.artifact.id,
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
