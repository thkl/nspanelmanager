import { Router } from "express";
import type { ConfigStore } from "../../services/config-store.js";
import type { Logger } from "../../services/logger.js";
import type { MqttRuntime } from "../../services/mqtt-runtime.js";
import type { BackupScheduler } from "../backups/backup-scheduler.js";

/** Creates authenticated endpoints for listing and restoring saved configuration revisions. */
export function createConfigHistoryRouter(store: ConfigStore, mqttRuntime: MqttRuntime, backupScheduler: BackupScheduler, logger: Logger): Router {
  const router = Router();

  router.get("/", (request, response) => {
    const requestedLimit = Number(request.query["limit"] ?? 100);
    const limit = Number.isSafeInteger(requestedLimit) ? requestedLimit : 100;
    response.setHeader("Cache-Control", "no-store");
    response.json({ revisions: store.listRevisions(limit) });
  });

  router.post("/:id/restore", async (request, response, next) => {
    const revisionId = Number(request.params.id);
    if (!Number.isSafeInteger(revisionId) || revisionId < 1) {
      return response.status(400).json({ error: "Choose a valid configuration revision." });
    }

    const previousConfig = store.get();
    let restored = false;
    try {
      const config = await store.restoreRevision(revisionId, request.authUser?.email ?? "unknown");
      if (!config) return response.status(404).json({ error: "Configuration revision not found." });
      restored = true;
      await backupScheduler.reconfigure(config.backupSettings);
      await mqttRuntime.reconnect();
      logger.warn("Manager configuration revision restored.", {
        component: "persistence",
        revisionId: String(revisionId),
        requestedBy: request.authUser?.email ?? "unknown"
      });
      return response.json({ restored: true, revisionId, revisions: store.listRevisions() });
    } catch (error) {
      if (restored) {
        try {
          await store.update((current) => {
            Object.assign(current, previousConfig);
          }, {
            actor: "system",
            summary: `Reverted failed restore of revision ${revisionId}`
          });
          await backupScheduler.reconfigure(previousConfig.backupSettings);
          await mqttRuntime.reconnect();
        } catch (recoveryError) {
          logger.error("Could not recover manager configuration after a failed revision restore.", {
            component: "persistence",
            revisionId: String(revisionId),
            detail: recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
          });
        }
      }
      return next(error);
    }
  });

  return router;
}
