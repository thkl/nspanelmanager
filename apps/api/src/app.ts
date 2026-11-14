import express, { type Express, type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import type { ConfigStore } from "./services/config-store.js";
import type { MqttRuntime } from "./services/mqtt-runtime.js";
import { createBrokerRouter } from "./routes/broker.js";
import { createLoggingRouter } from "./routes/logging.js";
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
import { createConfigHistoryRouter } from "./features/persistence/config-history.routes.js";
import type { BackupArchiveService } from "./features/backups/backup-archive-service.js";
import type { BackupScheduler } from "./features/backups/backup-scheduler.js";
import { createHmiDownloadRouter, createHmiRouter } from "./features/hmi/hmi.routes.js";
import type { HmiArtifactService } from "./features/hmi/hmi-artifact-service.js";
import type { HmiUpdateService } from "./features/hmi/hmi-update-service.js";
import { createFirmwareDownloadRouter, createFirmwareRouter } from "./features/firmware/firmware.routes.js";
import type { FirmwareArtifactService } from "./features/firmware/firmware-artifact-service.js";
import type { FirmwareUpdateService } from "./features/firmware/firmware-update-service.js";
import type { CoreDumpStore } from "./features/firmware/core-dump-store.js";
import { presentPluginProfile } from "./features/plugins/plugin-profile-utils.js";
import type { WinstonHttpLogSink } from "./services/logger.js";

const logger = new Logger();

/**
 * Assembles the Express application and its feature-focused API routers.
 *
 * This factory has no startup side effects, so HTTP concerns can be composed
 * separately from loading configuration and opening the MQTT connection. In
 * production it serves the Angular build from `WEB_ROOT`; local development
 * uses Angular CLI's dev server and proxies `/api` to this application.
 */
export function createApp(store: ConfigStore, mqttRuntime: MqttRuntime, pluginRegistry: PluginRegistry, authService: AuthService, logger: Logger, logFileReader: LogFileReader, backupService: BackupArchiveService, backupScheduler: BackupScheduler, hmiService: HmiArtifactService, hmiUpdateService: HmiUpdateService, firmwareService: FirmwareArtifactService, firmwareUpdateService: FirmwareUpdateService, coreDumpStore: CoreDumpStore, httpLogSink: WinstonHttpLogSink): Express {
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
  app.use("/api/backups", createBackupsRouter(backupService, backupScheduler, store, logger));
  app.use("/api/logging", createLoggingRouter(store, logger, httpLogSink));
  app.use("/api/config-revisions", createConfigHistoryRouter(store, mqttRuntime, backupScheduler, logger));
  app.use("/api/hmi", createHmiRouter(hmiService, hmiUpdateService, firmwareUpdateService, store, mqttRuntime, logger));
  app.use("/api/firmware", createFirmwareRouter(firmwareService, firmwareUpdateService, hmiUpdateService, store, mqttRuntime, logger, coreDumpStore));
  app.get("/api/health", (_request, response) => response.json({ ok: true, mqtt: mqttRuntime.status() }));
  app.get("/api/state", (_request, response) => response.json({ config: publicConfig(store.get(), pluginRegistry), mqtt: mqttRuntime.status() }));
  app.use("/api/broker", createBrokerRouter(store, mqttRuntime, pluginRegistry));
  app.use("/api/panels", createPanelRouter(store, mqttRuntime, pluginRegistry));
  app.use("/api/routes", createMqttRouteRouter(store, mqttRuntime));
  app.use("/api/plugins", createPluginsRouter(store, mqttRuntime, pluginRegistry, logger));
  app.use("/api", (_request, response) => response.status(404).json({ error: "API endpoint not found." }));
  app.use("/api", (error: unknown, request: Request, response: Response, next: NextFunction) => {
    const status = apiErrorStatus(error);
    const detail = apiErrorDetail(error);
    logger.error("Unhandled API request failed.", {
      component: "api",
      method: request.method,
      path: request.path,
      status: String(status),
      detail
    });
    if (response.headersSent) return next(error);
    return response.status(status).json({ error: status >= 500 ? "Internal server error." : detail });
  });

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
  const { bearerToken, password: httpPassword, ...httpLogTransport } = config.httpLogTransport;
  return {
    ...config,
    broker: { ...broker, passwordConfigured: Boolean(password) },
    httpLogTransport: {
      ...httpLogTransport,
      bearerTokenConfigured: Boolean(bearerToken),
      passwordConfigured: Boolean(httpPassword)
    },
    pluginProfiles: config.pluginProfiles.map((profile) => presentPluginProfile(profile, pluginRegistry))
  };
}

/** Uses an HTTP error's safe status field or defaults to an internal failure. */
function apiErrorStatus(error: unknown): number {
  if (!error || typeof error !== "object") return 500;
  const candidate = "statusCode" in error ? error.statusCode : "status" in error ? error.status : undefined;
  return typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 400 && candidate <= 599
    ? candidate
    : 500;
}

/** Includes a bounded chain of nested causes in the API diagnostic log. */
function apiErrorDetail(error: unknown, depth = 0): string {
  if (!(error instanceof Error)) return String(error);
  if (depth >= 3 || error.cause === undefined) return error.message;
  return `${error.message} (cause: ${apiErrorDetail(error.cause, depth + 1)})`;
}
