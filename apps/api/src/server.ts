import path from "node:path";
import { createServer, type Server } from "node:http";
import { createApp } from "./app.js";
import { ConfigStore } from "./services/config-store.js";
import { MqttRuntime } from "./services/mqtt-runtime.js";
import { RuntimeStateStore } from "./features/runtime/runtime-state-store.js";
import { createDefaultPluginRegistry } from "./features/plugins/default-plugin-registry.js";
import { Logger, WinstonFileLogSink } from "./services/logger.js";
import { AuthService } from "./features/auth/auth-service.js";
import { UserStore } from "./features/auth/user-store.js";
import { CredentialEncryption } from "./features/security/credential-encryption.js";
import { LogFileReader } from "./features/logs/log-file-reader.js";
import { BackupArchiveService } from "./features/backups/backup-archive-service.js";
import { HmiArtifactService } from "./features/hmi/hmi-artifact-service.js";
import { HmiUpdateService } from "./features/hmi/hmi-update-service.js";
import { FirmwareArtifactService } from "./features/firmware/firmware-artifact-service.js";
import { FirmwareUpdateService } from "./features/firmware/firmware-update-service.js";
import { RealtimeWebSocketServer } from "./features/realtime/realtime-websocket.js";
import { panelBootstrapTopicRoot } from "./domain/panel-topics.js";

const logger = new Logger();

/**
 * Starts the manager process after loading durable configuration.
 *
 * Startup order matters: profiles and broker credentials must be available
 * before the MQTT runtime connects and subscribes. The Express app then serves
 * the management API and production Angular files from the same origin.
 */
async function startServer(): Promise<void> {
  logger.debug(`we are running ${process.version}`, {
    component: "server"
  });
  const port = Number(process.env.PORT || 3000);
  const dataDir = process.env.DATA_DIR || path.resolve(process.cwd(), "data");
  const logDirectory = process.env.LOG_DIR?.trim() || path.join(dataDir, "logs");
  const logFileReader = new LogFileReader(logDirectory);
  logger.addSink(await WinstonFileLogSink.create(logDirectory));
  const encryptionKeyFile = process.env.MANAGER_ENCRYPTION_KEY_FILE?.trim() ||
    process.env.APP_ENCRYPTION_KEY_FILE?.trim() ||
    "../../secrets/manager_encryption_key";
  const credentialEncryption = await CredentialEncryption.fromFile(encryptionKeyFile);
  const store = new ConfigStore(dataDir, credentialEncryption);
  await store.load();
  const runtimeState = new RuntimeStateStore(dataDir, logger);
  await runtimeState.load();
  const backupService = new BackupArchiveService(dataDir, () => runtimeState.flush());
  const hmiPublicUrl = process.env.HMI_PUBLIC_URL?.trim() || process.env.APP_PUBLIC_URL?.trim() || "";
  const hmiService = new HmiArtifactService(dataDir, hmiPublicUrl);
  await hmiService.load();
  const firmwareService = new FirmwareArtifactService(dataDir, hmiPublicUrl);
  await firmwareService.load();
  const setUserStorePermissions = process.env.USER_STORE_SET_PERMISSIONS?.trim().toLowerCase() !== "false";
  const userStore = new UserStore(dataDir, setUserStorePermissions);
  await userStore.load();
  logger.debug("Checking OIDC environment configuration.", {
    component: "auth",
    appPublicUrlConfigured: String(Boolean(process.env.APP_PUBLIC_URL?.trim())),
    issuerConfigured: String(Boolean(process.env.OIDC_ISSUER_URL?.trim())),
    clientIdConfigured: String(Boolean(process.env.OIDC_CLIENT_ID?.trim())),
    clientSecretFileConfigured: String(Boolean(process.env.OIDC_CLIENT_SECRET_FILE?.trim()))
  });
  const authService = new AuthService(userStore);
  await authService.initialize();
  const ssoEnabled = authService.isSsoEnabled();
  const hasLocalUsers = userStore.listUsers().length > 0;
  const initialSetupToken = authService.getInitialSetupTokenForStartupLog();
  if (initialSetupToken) {
    logger.warn(`First-run setup token: ${initialSetupToken}`, { component: "auth", purpose: "first-run-setup" });
  }
  logger.info(ssoEnabled ? "OIDC single sign-on is enabled." : "OIDC single sign-on is disabled.", {
    component: "auth",
    ssoEnabled: String(ssoEnabled),
    hasLocalUsers: String(hasLocalUsers),
    ssoButtonAvailable: String(ssoEnabled && hasLocalUsers),
    ...(ssoEnabled ? { callbackUrl: authService.getOidcRedirectUrl().href } : {})
  });
  const pluginRegistry = createDefaultPluginRegistry();
  const mqttRuntime = new MqttRuntime(store, pluginRegistry, runtimeState, logger);
  let realtimeServer: RealtimeWebSocketServer | undefined;
  const hmiUpdateService = new HmiUpdateService(runtimeState, (job) => realtimeServer?.broadcast({ type: "hmi-job", job }), logger);
  const firmwareUpdateService = new FirmwareUpdateService(runtimeState, (job) => realtimeServer?.broadcast({ type: "firmware-job", job }), logger);
  const app = createApp(store, mqttRuntime, pluginRegistry, authService, logger, logFileReader, backupService, hmiService, hmiUpdateService, firmwareService, firmwareUpdateService);
  const httpServer = createServer(app);
  realtimeServer = new RealtimeWebSocketServer(httpServer, authService, async () => ({
    panels: mqttRuntime.panelConnectionStatuses(),
    discoveredPanels: mqttRuntime.discoveredPanelStatuses(),
    hmiJobs: await hmiUpdateService.getJobsForSnapshot(),
    firmwareJobs: await firmwareUpdateService.getJobsForSnapshot(),
    mqtt: mqttRuntime.status()
  }), logger);
  mqttRuntime.onPanelConnectionsChanged((panels) => realtimeServer?.broadcast({ type: "panels", panels }));
  mqttRuntime.onDiscoveredPanelsChanged((panels) => realtimeServer?.broadcast({ type: "discovered-panels", panels }));
  mqttRuntime.onMqttStatusChanged((mqtt) => realtimeServer?.broadcast({ type: "mqtt", mqtt }));
  mqttRuntime.onHmiUpdateReport((panel, payload, receivedAt) => hmiUpdateService.handlePanelReport(panel, payload, receivedAt));
  mqttRuntime.onFirmwareUpdateReport(async (panel, payload, receivedAt) => {
    const recovered = await firmwareUpdateService.handlePanelReport(panel, payload, receivedAt);
    if (recovered && panel.unifiedFirmware) mqttRuntime.publishPanelSettings(panel, true, panelBootstrapTopicRoot(panel));
  });
  mqttRuntime.onPanelPing((panel, telemetry, receivedAt) => hmiUpdateService.observePanelPing(panel, telemetry, receivedAt));
  mqttRuntime.onPanelPing(async (panel, telemetry, receivedAt) => {
    const recovered = await firmwareUpdateService.observePanelPing(panel, telemetry, receivedAt);
    if (recovered && panel.unifiedFirmware) mqttRuntime.publishPanelSettings(panel, true, panelBootstrapTopicRoot(panel));
  });
  hmiUpdateService.start();
  firmwareUpdateService.start();
  await mqttRuntime.reconnect();
  httpServer.listen(port, () => logger.info(`NSPanel Manager listening on port ${port}`, { component: "server" }));
  registerShutdownHandlers(httpServer, realtimeServer, hmiUpdateService, firmwareUpdateService, mqttRuntime, runtimeState, logger);
}

/** Flushes the coalesced runtime snapshot after stopping new HTTP and MQTT work. */
function registerShutdownHandlers(httpServer: Server, realtimeServer: RealtimeWebSocketServer, hmiUpdateService: HmiUpdateService, firmwareUpdateService: FirmwareUpdateService, mqttRuntime: MqttRuntime, runtimeState: RuntimeStateStore, logger: Logger): void {
  let shutdownStarted = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    logger.info("Stopping NSPanel Manager.", { component: "server", signal });
    try {
      hmiUpdateService.close();
      firmwareUpdateService.close();
      await realtimeServer.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => error ? reject(error) : resolve());
      });
      await mqttRuntime.close();
      await runtimeState.flush();
      logger.info("NSPanel Manager stopped cleanly.", { component: "server" });
      await logger.close();
      process.exit(0);
    } catch (error) {
      logger.error("NSPanel Manager shutdown failed.", {
        component: "server",
        detail: error instanceof Error ? error.message : String(error)
      });
      process.exit(1);
    }
  };
  process.once("SIGINT", () => { void shutdown("SIGINT"); });
  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
}

void startServer().catch(async (error: unknown) => {
  logger.error("NSPanel Manager failed to start.", {
    component: "server",
    detail: error instanceof Error ? error.message : String(error)
  });
  await logger.close();
  process.exitCode = 1;
});
