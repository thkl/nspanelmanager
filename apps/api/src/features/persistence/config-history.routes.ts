import { Router } from "express";
import type { ConfigRevisionScopeType, ConfigStore } from "../../services/config-store.js";
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

  router.get("/:id/scopes", (request, response) => {
    const revisionId = Number(request.params.id);
    if (!Number.isSafeInteger(revisionId) || revisionId < 1) {
      return response.status(400).json({ error: "Choose a valid configuration revision." });
    }
    const scopes = store.getRevisionScopes(revisionId);
    if (!scopes) return response.status(404).json({ error: "Configuration revision not found." });
    response.setHeader("Cache-Control", "no-store");
    return response.json({ scopes });
  });

  router.post("/:id/restore-scope", async (request, response, next) => {
    const revisionId = Number(request.params.id);
    const scope = request.body?.scope;
    const targetId = typeof request.body?.targetId === "string" ? request.body.targetId.trim() : "";
    if (!Number.isSafeInteger(revisionId) || revisionId < 1) {
      return response.status(400).json({ error: "Choose a valid configuration revision." });
    }
    if (!isConfigRevisionScopeType(scope) || !targetId) {
      return response.status(400).json({ error: "Choose a configuration section to restore." });
    }

    const previousConfig = store.get();
    let restored = false;
    try {
      const config = await store.restoreRevisionScope(
        revisionId,
        scope,
        targetId,
        request.authUser?.email ?? "unknown"
      );
      if (!config) return response.status(404).json({ error: "The selected item is not available in this revision." });
      restored = true;
      await mqttRuntime.reconnect();
      logger.warn("Manager configuration section restored.", {
        component: "persistence",
        revisionId: String(revisionId),
        scope,
        targetId,
        requestedBy: request.authUser?.email ?? "unknown"
      });
      return response.json({ restored: true, revisionId, scope, targetId, revisions: store.listRevisions() });
    } catch (error) {
      if (restored) {
        try {
          await store.update((current) => {
            Object.assign(current, previousConfig);
          }, {
            actor: "system",
            summary: `Reverted failed scoped restore from revision ${revisionId}`
          });
          await mqttRuntime.reconnect();
        } catch (recoveryError) {
          logger.error("Could not recover manager configuration after a failed scoped restore.", {
            component: "persistence",
            revisionId: String(revisionId),
            detail: recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
          });
        }
      }
      return next(error);
    }
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

/** Checks the bounded scope values accepted by the scoped restore endpoint. */
function isConfigRevisionScopeType(value: unknown): value is ConfigRevisionScopeType {
  return value === "panel" || value === "plugin-profile" || value === "plugin-instance";
}
