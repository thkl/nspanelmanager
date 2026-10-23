import express, { type Express } from "express";
import path from "node:path";
import type { ConfigStore } from "./services/config-store.js";
import type { MqttRuntime } from "./services/mqtt-runtime.js";
import { createBrokerRouter } from "./routes/broker.js";
import { createMqttRouteRouter } from "./routes/mqtt-routes.js";
import { createPanelRouter } from "./routes/panels.js";
import { createPluginsRouter } from "./features/plugins/plugins.routes.js";
import type { PluginRegistry } from "./features/plugins/plugin-registry.js";
import { createAuthRouter, requireAuthenticatedUser, requireSameOrigin } from "./features/auth/auth.routes.js";
import type { AuthService } from "./features/auth/auth-service.js";
import { Logger } from "./services/logger.js";
import { createLogsRouter } from "./features/logs/logs.routes.js";
import type { LogFileReader } from "./features/logs/log-file-reader.js";
import { createBackupsRouter } from "./features/backups/backups.routes.js";
import type { BackupArchiveService } from "./features/backups/backup-archive-service.js";
import { createHmiDownloadRouter, createHmiRouter } from "./features/hmi/hmi.routes.js";
import type { HmiArtifactService } from "./features/hmi/hmi-artifact-service.js";
import type { HmiUpdateService } from "./features/hmi/hmi-update-service.js";
import { createFirmwareDownloadRouter, createFirmwareRouter } from "./features/firmware/firmware.routes.js";
import type { FirmwareArtifactService } from "./features/firmware/firmware-artifact-service.js";
import type { FirmwareUpdateService } from "./features/firmware/firmware-update-service.js";

const logger = new Logger();

/**
 * Assembles the Express application and its feature-focused API routers.
 *
 * This factory has no startup side effects, so HTTP concerns can be composed
 * separately from loading configuration and opening the MQTT connection. In
 * production it serves the Angular build from `WEB_ROOT`; local development
 * uses Angular CLI's dev server and proxies `/api` to this application.
 */
export function createApp(store: ConfigStore, mqttRuntime: MqttRuntime, pluginRegistry: PluginRegistry, authService: AuthService, logger: Logger, logFileReader: LogFileReader, backupService: BackupArchiveService, hmiService: HmiArtifactService, hmiUpdateService: HmiUpdateService, firmwareService: FirmwareArtifactService, firmwareUpdateService: FirmwareUpdateService): Express {
  const app = express();
  app.set("trust proxy", parseTrustProxySetting(process.env.TRUST_PROXY));
  app.disable("x-powered-by");
  app.use(express.json({ limit: "128kb" }));

  const isDevelopment = process.env.NODE_ENV === 'development';

  if (!isDevelopment) {
    logger.debug("Enabling CORS");
    app.use("/api", requireSameOrigin(process.env.APP_PUBLIC_URL?.trim() ?? ""));
  } else {
    logger.debug("System is in dev mode");
  }

  app.use("/api/auth", createAuthRouter(authService, logger));
  app.use("/api/hmi", createHmiDownloadRouter(hmiService, logger));
  app.use("/api/firmware", createFirmwareDownloadRouter(firmwareService, logger));
  app.use("/api", requireAuthenticatedUser(authService));

  app.use("/api/logs", createLogsRouter(logFileReader));
  app.use("/api/backups", createBackupsRouter(backupService, logger));
  app.use("/api/hmi", createHmiRouter(hmiService, hmiUpdateService, firmwareUpdateService, store, mqttRuntime, logger));
  app.use("/api/firmware", createFirmwareRouter(firmwareService, firmwareUpdateService, hmiUpdateService, store, mqttRuntime, logger));
  app.get("/api/health", (_request, response) => response.json({ ok: true, mqtt: mqttRuntime.status() }));
  app.get("/api/state", (_request, response) => response.json({ config: publicConfig(store.get(), pluginRegistry), mqtt: mqttRuntime.status() }));
  app.use("/api/broker", createBrokerRouter(store, mqttRuntime, pluginRegistry));
  app.use("/api/panels", createPanelRouter(store, mqttRuntime, pluginRegistry));
  app.use("/api/routes", createMqttRouteRouter(store, mqttRuntime));
  app.use("/api/plugins", createPluginsRouter(store, mqttRuntime, pluginRegistry));
  app.use("/api", (_request, response) => response.status(404).json({ error: "API endpoint not found." }));

  const webRoot = process.env.WEB_ROOT || path.resolve(process.cwd(), "../web/dist/web/browser");
  app.use(express.static(webRoot));
  app.use((request, response, next) => {
    if (request.method !== "GET" || !request.accepts("html")) return next();
    response.sendFile(path.join(webRoot, "index.html"), (error) => { if (error) next(); });
  });
  return app;
}

/** Parses the Express trust proxy setting, defaulting to the direct socket peer. */
function parseTrustProxySetting(rawValue: string | undefined): boolean | number | string {
  const value = rawValue?.trim();
  if (!value || value.toLowerCase() === "false") return false;
  if (value.toLowerCase() === "true") return true;
  if (/^-?\d+$/.test(value)) {
    const hops = Number(value);
    if (!Number.isSafeInteger(hops) || hops < 0) throw new Error("TRUST_PROXY must be false, true, a non-negative hop count, or a proxy IP/CIDR list.");
    return hops;
  }
  if (value.split(",").some((entry) => !entry.trim())) {
    throw new Error("TRUST_PROXY contains an empty proxy address or subnet.");
  }
  return value;
}

function publicConfig(config: ReturnType<ConfigStore["get"]>, pluginRegistry: PluginRegistry) {
  const { password, ...broker } = config.broker;
  return {
    ...config,
    broker: { ...broker, passwordConfigured: Boolean(password) },
    pluginProfiles: config.pluginProfiles.map((profile) => ({ ...profile, pluginId: pluginRegistry.canonicalId(profile.pluginId) }))
  };
}
