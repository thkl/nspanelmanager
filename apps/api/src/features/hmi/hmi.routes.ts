import express, { Router } from "express";
import { createReadStream } from "node:fs";
import type { Logger } from "../../services/logger.js";
import type { ConfigStore } from "../../services/config-store.js";
import type { MqttRuntime } from "../../services/mqtt-runtime.js";
import { HmiArtifactError, HmiArtifactService, MAX_HMI_FILE_BYTES } from "./hmi-artifact-service.js";
import { HmiUpdateError, HmiUpdateService } from "./hmi-update-service.js";
import { panelBootstrapTopicRoot } from "../../domain/panel-topics.js";
import type { FirmwareUpdateService } from "../firmware/firmware-update-service.js";

/** Creates protected HMI upload and panel update endpoints. */
export function createHmiRouter(hmiService: HmiArtifactService, hmiUpdateService: HmiUpdateService, firmwareUpdateService: FirmwareUpdateService, store: ConfigStore, mqttRuntime: MqttRuntime, logger: Logger): Router {
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
    const forceValue: unknown = request.body?.force;
    if (forceValue !== undefined && typeof forceValue !== "boolean") return response.status(400).json({ error: "The force option must be a boolean." });
    const force = forceValue === true;
    const panelId = request.params.panelId;
    const panel = store.get().panels.find((item) => item.id === panelId);
    if (!panel) return response.status(404).json({ error: "Panel not found." });
    if (firmwareUpdateService.hasActiveJob(panel.id)) return response.status(409).json({ error: `A firmware update for ${panel.name} is already in progress.` });
    if (!mqttRuntime.status().connected) return response.status(503).json({ error: "The MQTT broker is not connected." });

    try {
      const download = await hmiService.createDownloadUrl();
      const topic = `${panelBootstrapTopicRoot(panel)}/cmnd/updatehmi`;
      const job = await hmiUpdateService.begin(panel, download.artifact, force, download.expiresAt, request.authUser?.email);
      if (!mqttRuntime.publishHmiUpdate(panel, download.url, download.artifact.sha256, job.id, force)) {
        await hmiUpdateService.markPublishFailed(job.id, "The MQTT broker disconnected before the update request could be sent.");
        return response.status(503).json({ error: "The MQTT broker disconnected before the update request could be sent.", job: hmiUpdateService.getJob(job.id) });
      }
      await hmiUpdateService.markPublished(job.id);
      logger.info("HMI update request published.", {
        component: "hmi",
        panel: panel.nodeName,
        artifactId: download.artifact.id,
        jobId: job.id,
        hmiVersion: download.artifact.sha256,
        force: String(force),
        grantExpiresAt: download.expiresAt,
        requestedBy: request.authUser?.email ?? "unknown"
      });
      response.json({ published: true, panel: { id: panel.id, name: panel.name }, topic, expiresAt: download.expiresAt, hmiVersion: download.artifact.sha256, job: hmiUpdateService.getJob(job.id) ?? job });
    } catch (error) {
      if (error instanceof HmiArtifactError) response.status(error.statusCode).json({ error: error.message });
      else if (error instanceof HmiUpdateError) response.status(error.statusCode).json({ error: error.message });
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

  router.head("/download/:token", async (request, response, next) => {
    try {
      const download = await hmiService.resolveDownload(request.params.token);
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      if (!download) return response.status(404).end();
      response.setHeader("Content-Type", "application/octet-stream");
      response.setHeader("Content-Length", String(download.artifact.size));
      response.setHeader("Content-Disposition", "attachment; filename=\"hmi.tft\"");
      response.setHeader("Accept-Ranges", "bytes");
      response.end();
    } catch (error) { next(error); }
  });

  router.get("/download/:token", async (request, response, next) => {
    try {
      const download = await hmiService.resolveDownload(request.params.token);
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      if (!download) return response.status(404).json({ error: "This HMI download link is invalid or has expired." });

      response.setHeader("Content-Type", "application/octet-stream");
      response.setHeader("Content-Disposition", "attachment; filename=\"hmi.tft\"");
      response.setHeader("Accept-Ranges", "bytes");

      const range = parseByteRange(request.get("range"), download.artifact.size);
      if (range === "unsatisfiable") {
        response.setHeader("Content-Range", `bytes */${download.artifact.size}`);
        return response.status(416).end();
      }

      const start = range?.start ?? 0;
      const end = range?.end ?? download.artifact.size - 1;
      response.setHeader("Content-Length", String(end - start + 1));
      if (range) {
        response.status(206);
        response.setHeader("Content-Range", `bytes ${start}-${end}/${download.artifact.size}`);
      }
      const stream = createReadStream(download.filePath, { start, end });
      response.on("close", () => { if (!response.writableEnded) stream.destroy(); });
      response.on("finish", () => logger.info("HMI artifact downloaded by a panel.", {
        component: "hmi",
        artifactId: download.artifact.id,
        size: String(end - start + 1),
        range: range ? `${start}-${end}` : "full"
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

/** Parses one RFC 7233 byte range; unsupported units are treated as a full-file request. */
function parseByteRange(value: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | undefined {
  if (!value) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match && !/^bytes=/i.test(value.trim())) return undefined;
  if (!match) return "unsatisfiable";

  const first = match[1] ?? "";
  const last = match[2] ?? "";
  if (!first && !last) return "unsatisfiable";

  if (!first) {
    const suffixLength = Number(last);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0 || size <= 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(first);
  const requestedEnd = last ? Number(last) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= size || requestedEnd < start) {
    return "unsatisfiable";
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}
