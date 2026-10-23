import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { AuthService } from "../auth/auth-service.js";
import type { DiscoveredPanel, FirmwareUpdateJob, HmiUpdateJob, PanelConnectionStatus } from "../../types.js";
import type { Logger } from "../../services/logger.js";

const SOCKET_PATH = "/api/events";
const MAX_CLIENTS = 64;
const SESSION_CHECK_INTERVAL_MS = 60 * 1000;
const PANEL_STATUS_REFRESH_INTERVAL_MS = 15 * 1000;

export interface RealtimeSnapshot {
  panels: PanelConnectionStatus[];
  discoveredPanels: DiscoveredPanel[];
  hmiJobs: HmiUpdateJob[];
  firmwareJobs: FirmwareUpdateJob[];
  mqtt: { connected: boolean; error: string };
}

export type RealtimeEvent =
  | { type: "snapshot"; panels: PanelConnectionStatus[]; discoveredPanels: DiscoveredPanel[]; hmiJobs: HmiUpdateJob[]; firmwareJobs: FirmwareUpdateJob[]; mqtt: { connected: boolean; error: string } }
  | { type: "panels"; panels: PanelConnectionStatus[] }
  | { type: "discovered-panels"; panels: DiscoveredPanel[] }
  | { type: "hmi-job"; job: HmiUpdateJob }
  | { type: "firmware-job"; job: FirmwareUpdateJob }
  | { type: "mqtt"; mqtt: { connected: boolean; error: string } };

interface RealtimeClient {
  socket: WebSocket;
  sessionToken: string;
  alive: boolean;
  initialized: boolean;
  pendingEvents: RealtimeEvent[];
}

/** Serves same-origin authenticated WebSocket snapshots and live manager events. */
export class RealtimeWebSocketServer {
  private readonly webSockets = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  private readonly clients = new Set<RealtimeClient>();
  private readonly expectedOrigin = process.env.NODE_ENV !== "development" && process.env.APP_PUBLIC_URL?.trim()
    ? new URL(process.env.APP_PUBLIC_URL).origin
    : undefined;
  private readonly sessionTimer: ReturnType<typeof setInterval>;
  private readonly panelStatusTimer: ReturnType<typeof setInterval>;
  private lastPanelSnapshot = "";
  private closed = false;
  private readonly handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let pathname: string;
    try { pathname = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`).pathname; }
    catch { return rejectUpgrade(socket, 400, "Bad Request"); }
    if (pathname !== SOCKET_PATH) return rejectUpgrade(socket, 404, "Not Found");
    void this.authenticateUpgrade(request, socket, head);
  };

  constructor(
    private readonly server: Server,
    private readonly auth: AuthService,
    private readonly getSnapshot: () => Promise<RealtimeSnapshot>,
    private readonly logger: Logger
  ) {
    server.on("upgrade", this.handleUpgrade);
    this.sessionTimer = setInterval(() => { void this.checkClients(); }, SESSION_CHECK_INTERVAL_MS);
    this.panelStatusTimer = setInterval(() => { void this.refreshPanelSnapshot(); }, PANEL_STATUS_REFRESH_INTERVAL_MS);
  }

  /** Sends a validated server event to all authenticated connected browsers. */
  broadcast(event: RealtimeEvent): void {
    if (this.closed) return;
    if (event.type === "panels") this.lastPanelSnapshot = JSON.stringify(event.panels);
    const serialized = JSON.stringify(event);
    for (const client of this.clients) {
      this.sendEvent(client, event, serialized);
    }
  }

  /** Closes authenticated browser sockets before the HTTP server shuts down. */
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.sessionTimer);
    clearInterval(this.panelStatusTimer);
    this.server.off("upgrade", this.handleUpgrade);
    for (const client of this.clients) client.socket.terminate();
    this.clients.clear();
    await new Promise<void>((resolve) => this.webSockets.close(() => resolve()));
  }

  private async authenticateUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (!this.isSameOrigin(request)) return rejectUpgrade(socket, 403, "Forbidden");
    if (this.clients.size >= MAX_CLIENTS) return rejectUpgrade(socket, 503, "Too many connections");
    const sessionToken = readSessionCookie(request.headers.cookie);
    let user;
    try { user = sessionToken ? await this.auth.resolveSessionToken(sessionToken) : undefined; }
    catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn("Could not authenticate realtime WebSocket connection.", { component: "realtime", detail });
      return rejectUpgrade(socket, 401, "Unauthorized");
    }
    if (!sessionToken || !user) return rejectUpgrade(socket, 401, "Unauthorized");

    if (this.closed || socket.destroyed) return;
    this.webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      const client: RealtimeClient = { socket: webSocket, sessionToken, alive: true, initialized: false, pendingEvents: [] };
      this.clients.add(client);
      webSocket.on("pong", () => { client.alive = true; });
      webSocket.on("message", () => webSocket.close(1008, "This connection is read-only."));
      webSocket.on("close", () => this.clients.delete(client));
      webSocket.on("error", (error) => {
        this.logger.warn("Realtime WebSocket connection failed.", { component: "realtime", detail: error.message });
        this.clients.delete(client);
      });
      void this.sendSnapshot(client);
    });
  }

  private async sendSnapshot(client: RealtimeClient): Promise<void> {
    try {
      const snapshot = await this.getSnapshot();
      if (client.socket.readyState === WebSocket.OPEN) {
        client.socket.send(JSON.stringify({ type: "snapshot", ...snapshot } satisfies RealtimeEvent));
        client.initialized = true;
        for (const event of client.pendingEvents.splice(0)) this.sendEvent(client, event, JSON.stringify(event));
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error("Could not prepare realtime snapshot.", { component: "realtime", detail });
      client.socket.close(1011, "Could not load manager state.");
    }
  }

  private async refreshPanelSnapshot(): Promise<void> {
    if (this.closed || this.clients.size === 0) return;
    try {
      const panels = (await this.getSnapshot()).panels;
      const serialized = JSON.stringify(panels);
      if (serialized !== this.lastPanelSnapshot) this.broadcast({ type: "panels", panels });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn("Could not refresh realtime panel status.", { component: "realtime", detail });
    }
  }

  private sendEvent(client: RealtimeClient, event: RealtimeEvent, serialized: string): void {
    if (client.socket.readyState !== WebSocket.OPEN) return;
    if (!client.initialized) {
      client.pendingEvents.push(event);
      if (client.pendingEvents.length > 100) client.socket.close(1013, "Realtime snapshot is taking too long.");
      return;
    }
    try { client.socket.send(serialized); }
    catch { client.socket.terminate(); }
  }

  private async checkClients(): Promise<void> {
    for (const client of [...this.clients]) {
      if (client.socket.readyState !== WebSocket.OPEN) continue;
      if (!client.alive) {
        client.socket.terminate();
        this.clients.delete(client);
        continue;
      }
      client.alive = false;
      client.socket.ping();
      try {
        const user = await this.auth.resolveSessionToken(client.sessionToken);
        if (!user) {
          client.socket.close(4401, "Sign in to continue.");
          this.clients.delete(client);
        }
      } catch {
        client.socket.close(4401, "Sign in to continue.");
        this.clients.delete(client);
      }
    }
  }

  private isSameOrigin(request: IncomingMessage): boolean {
    const rawOrigin = request.headers.origin;
    if (!rawOrigin) return false;
    try {
      const origin = new URL(rawOrigin).origin;
      if (this.expectedOrigin) return origin === this.expectedOrigin;
      const host = request.headers.host;
      return Boolean(host && new URL(origin).host === host);
    } catch { return false; }
  }
}

function readSessionCookie(header: string | undefined): string | undefined {
  const session = header?.split(";").map((part) => part.trim()).find((part) => part.startsWith("nspanel_session="))?.slice("nspanel_session=".length);
  return session && /^[a-f0-9]{64}$/.test(session) ? session : undefined;
}

function rejectUpgrade(socket: Duplex, status: 400 | 401 | 403 | 404 | 503, message: string): void {
  if (socket.destroyed) return;
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}
