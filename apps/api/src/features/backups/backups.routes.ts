import { Router } from "express";
import type { ArchiverError } from "archiver";
import type { Logger } from "../../services/logger.js";
import type { ConfigStore } from "../../services/config-store.js";
import type { BackupSettings } from "../../types.js";
import { BackupArchiveService } from "./backup-archive-service.js";
import { BackupScheduler } from "./backup-scheduler.js";

/** Creates the authenticated, no-cache endpoint for downloading a data archive. */
export function createBackupsRouter(backupService: BackupArchiveService, backupScheduler: BackupScheduler, store: ConfigStore, logger: Logger): Router {
  const router = Router();

  router.put("/settings", async (request, response, next) => {
    const settings = parseBackupSettings(request.body);
    if (!settings) return response.status(400).json({ error: "Enter a valid schedule, backup folder, and retention count between 1 and 365." });
    const previousSettings = store.get().backupSettings;
    try {
      await backupScheduler.reconfigure(settings);
    } catch (error) {
      return response.status(400).json({ error: error instanceof Error ? error.message : "Could not apply backup settings." });
    }

    try {
      await store.update((config) => { config.backupSettings = settings; });
    } catch (error) {
      try {
        await backupScheduler.reconfigure(previousSettings);
      } catch (rollbackError) {
        logger.error("Could not restore the previous scheduled backup settings.", {
          component: "backup",
          detail: rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
        });
      }
      return next(error);
    }

    logger.info("Scheduled ZIP backup settings updated.", {
      component: "backup",
      schedule: settings.schedule,
      enabled: String(settings.enabled),
      retentionCount: String(settings.retentionCount),
      requestedBy: request.authUser?.email ?? "unknown"
    });
    return response.json({ backupSettings: settings });
  });

  router.get("/download", async (request, response, next) => {
    try {
      const archive = await backupService.createArchive();
      const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
      const filename = `nspanel-manager-data-${timestamp}.zip`;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "application/zip");
      response.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.on("close", () => {
        if (!response.writableEnded) archive.abort();
      });
      response.on("finish", () => logger.info("Manager data backup downloaded.", {
        component: "backup",
        requestedBy: request.authUser?.email ?? "unknown",
        archiveBytes: String(archive.pointer())
      }));
      const archiveError = new Promise<never>((_resolve, reject) => {
        archive.once("error", (error: ArchiverError) => reject(error));
      });
      archive.on("warning", (error) => archive.emit("error", error));
      archive.on("error", (error) => {
        logger.error("Could not create manager data backup.", { component: "backup", detail: error.message });
      });
      archive.pipe(response);
      await Promise.race([archive.finalize(), archiveError]);
    } catch (error) {
      if (response.headersSent) response.destroy(error instanceof Error ? error : new Error(String(error)));
      else next(error);
    }
  });

  return router;
}

function parseBackupSettings(value: unknown): BackupSettings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (typeof input.enabled !== "boolean" || typeof input.schedule !== "string" ||
    typeof input.directory !== "string" || !input.directory.trim() || input.directory.length > 512 ||
    typeof input.retentionCount !== "number" || !Number.isInteger(input.retentionCount) || input.retentionCount < 1 || input.retentionCount > 365) {
    return undefined;
  }
  return {
    enabled: input.enabled,
    schedule: input.schedule.trim(),
    retentionCount: input.retentionCount,
    directory: input.directory.trim()
  };
}
