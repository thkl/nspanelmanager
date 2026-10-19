import { Router } from "express";
import type { ArchiverError } from "archiver";
import type { Logger } from "../../services/logger.js";
import { BackupArchiveService } from "./backup-archive-service.js";

/** Creates the authenticated, no-cache endpoint for downloading a data archive. */
export function createBackupsRouter(backupService: BackupArchiveService, logger: Logger): Router {
  const router = Router();

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
