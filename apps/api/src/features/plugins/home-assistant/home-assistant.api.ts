import { WebSocket } from "ws";
import type { PluginConfigValue, ResolvedPluginInstance } from "../../../types.js";
import type { PluginState } from "../plugin-contract.js";
import { configString } from "../plugin-contract.js";
import { XYToRGB } from "../nextion-color-wheel.js";

/** Domains whose favorite action can use Home Assistant's generic toggle service. */
const TOGGLEABLE_DOMAINS = new Set(["fan", "input_boolean", "light", "media_player", "switch"]);

/** Domains with implemented state mapping and panel behavior. */
const SUPPORTED_DOMAINS = new Set([...TOGGLEABLE_DOMAINS, "cover", "vacuum"]);

/**
 * Owns the Home Assistant network boundary and the conversions between HA
 * responses and the manager's normalized plugin state.
 */

/** One entity state returned by Home Assistant's REST API. */
export interface HomeAssistantEntity {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
}

/** A supported entity option enriched with its Home Assistant area, if known. */
export interface HomeAssistantEntityOption {
  entityId: string;
  name: string;
  state: string;
  domain: string;
  areaId?: string;
  areaName?: string;
}

/** Result of loading selectable entities and their area metadata. */
export interface HomeAssistantEntityOptions {
  entities: HomeAssistantEntityOption[];
  areasAvailable: boolean;
}

/** Entity Registry fields needed to resolve an entity's direct or device area. */
interface HomeAssistantEntityRegistryEntry {
  entity_id: string;
  area_id?: string | null;
  device_id?: string | null;
}

/** Device Registry fields needed when an entity inherits its device's area. */
interface HomeAssistantDeviceRegistryEntry {
  id: string;
  area_id?: string | null;
}

/** Area Registry fields used to turn area identifiers into human-readable names. */
interface HomeAssistantAreaRegistryEntry {
  id: string;
  name: string;
}

/** Loads supported entity states and joins them with Home Assistant area registries. */
export async function fetchHomeAssistantEntityOptions(baseUrl: string, accessToken: string): Promise<HomeAssistantEntityOptions> {
  const response = await homeAssistantFetch(baseUrl, accessToken, "/api/states");
  if (!Array.isArray(response)) throw new Error("Home Assistant returned an invalid entity list.");

  const states = response
    .filter((entity): entity is HomeAssistantEntity => isRecord(entity) && isSupportedEntityId(entity["entity_id"]))
    .map((entity) => ({
      entityId: entity.entity_id,
      name: displayValue(entity.attributes?.["friendly_name"], entity.entity_id),
      state: typeof entity.state === "string" ? entity.state : "unknown",
      domain: entityDomain(entity.entity_id) ?? ""
    }));

  try {
    const [entityRegistry, deviceRegistry, areaRegistry] = await homeAssistantWebSocketRequests(baseUrl, accessToken, [
      "config/entity_registry/list",
      "config/device_registry/list",
      "config/area_registry/list"
    ]);
    const entityEntries = parseEntityRegistry(entityRegistry);
    const deviceEntries = parseDeviceRegistry(deviceRegistry);
    const areaEntries = parseAreaRegistry(areaRegistry);
    const entityById = new Map(entityEntries.map((entry) => [entry.entity_id, entry]));
    const deviceAreaById = new Map(deviceEntries.map((entry) => [entry.id, entry.area_id]));
    const areaNameById = new Map(areaEntries.map((entry) => [entry.id, entry.name]));
    const entities = states.map((entity) => {
      const registryEntry = entityById.get(entity.entityId);
      const areaId = registryEntry?.area_id ?? (registryEntry?.device_id ? deviceAreaById.get(registryEntry.device_id) : undefined);
      const areaName = areaId ? areaNameById.get(areaId) : undefined;
      return {
        ...entity,
        ...(areaId ? { areaId } : {}),
        ...(areaName ? { areaName } : {})
      };
    });
    return { entities: sortHomeAssistantEntities(entities), areasAvailable: true };
  } catch {
    // Keep type and text filtering available if a reverse proxy blocks the registry WebSocket.
    return { entities: sortHomeAssistantEntities(states), areasAvailable: false };
  }
}

/** Returns the configured, validated entity ID for a plugin instance. */
export function requiredEntityId(instance: ResolvedPluginInstance): string {
  const entityId = instance.variables.entityId?.trim() ?? "";
  if (!isSupportedEntityId(entityId)) throw new Error("Choose a supported Home Assistant entity for this instance.");
  return entityId;
}

/** Reads one entity state from the Home Assistant REST API. */
export async function getHomeAssistantEntity(instance: ResolvedPluginInstance, entityId: string): Promise<HomeAssistantEntity> {
  const encodedEntityId = entityId.split(".").map(encodeURIComponent).join(".");
  const value = await homeAssistantFetch(
    configString(instance, "baseUrl"),
    configString(instance, "accessToken"),
    `/api/states/${encodedEntityId}`
  );
  if (!isRecord(value) || typeof value["entity_id"] !== "string" || typeof value["state"] !== "string") {
    throw new Error(`Home Assistant returned invalid state for ${entityId}.`);
  }
  return value as unknown as HomeAssistantEntity;
}

/** Calls one HA service for the selected entity and any service-specific data. */
export async function callHomeAssistantService(
  instance: ResolvedPluginInstance,
  domain: string,
  service: string,
  entityId: string,
  data: Record<string, unknown> = {}
): Promise<void> {
  await homeAssistantFetch(
    configString(instance, "baseUrl"),
    configString(instance, "accessToken"),
    `/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`,
    {
      method: "POST",
      body: JSON.stringify({ entity_id: entityId, ...data })
    }
  );
}

/** Converts HA's raw state and attributes into the plugin's cached state shape. */
export function entityStatePatch(entity: HomeAssistantEntity): PluginState {
  const domain = entityDomain(entity.entity_id);
  const attributes = entity.attributes ?? {};
  const state = entity.state.trim().toLowerCase();
  const patch: PluginState = {
    entityId: entity.entity_id,
    entityDomain: domain,
    entityState: entity.state,
    entityName: displayValue(attributes["friendly_name"], entity.entity_id),
    available: state !== "unavailable" && state !== "unknown",
    isOn: ["on", "playing", "buffering", "cleaning", "returning", "paused"].includes(state)
  };

  if (domain === "light") {
    const brightness = numberValue(attributes, "brightness");
    if (brightness !== undefined) {
      patch["brightness"] = Math.round(brightness / 255 * 100);
      patch["lastBrightness"] = patch["brightness"];
    }
    const rgbColor = attributes["rgb_color"];
    if (isRgbColor(rgbColor)) patch["rgbColor"] = rgbColor;
  }
  if (domain === "cover") {
    const position = numberValue(attributes, "current_position");
    if (position !== undefined) patch["position"] = clampPercent(position);
  }
  if (domain === "vacuum") {
    const batteryLevel = numberValue(attributes, "battery_level");
    if (batteryLevel !== undefined) patch["batteryLevel"] = batteryLevel;
    if (typeof attributes["fan_speed"] === "string") patch["fanSpeed"] = attributes["fan_speed"];
    if (typeof attributes["error"] === "string") patch["vacuumError"] = attributes["error"];
    if (typeof attributes["status"] === "string") patch["vacuumStatus"] = attributes["status"];
  }
  return patch;
}

/** Checks whether a URL can be used as the HTTP or HTTPS Home Assistant base URL. */
export function validHomeAssistantBaseUrl(value: string): boolean {
  try {
    normalizeHomeAssistantBaseUrl(value);
    return true;
  } catch {
    return false;
  }
}

/** Reads a string field from saved plugin configuration. */
export function stringValue(config: Record<string, PluginConfigValue>, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value : "";
}

/** Reads a finite numeric property from an untyped state or configuration map. */
export function numberValue(value: Record<string, unknown>, key: string): number | undefined {
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

/** Parses a number from a number or a numeric string. */
export function scalarNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Rounds a value and restricts it to the panel's zero-to-one-hundred range. */
export function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** Returns the entity's Home Assistant domain prefix, when an ID is present. */
export function entityDomain(entityId: string | undefined): string | undefined {
  return entityId?.split(".")[0]?.toLowerCase();
}

/** Allows only entity IDs from domains that this plugin knows how to control. */
export function isSupportedEntityId(value: unknown): value is string {
  if (typeof value !== "string" || !/^[a-z_][a-z0-9_]*\.[a-z0-9_]+$/i.test(value)) return false;
  const domain = entityDomain(value);
  return Boolean(domain && SUPPORTED_DOMAINS.has(domain));
}

/** Converts the panel color-wheel coordinate event into Home Assistant RGB channels. */
export function parseNextionWheelColor(value: string): [number, number, number] | undefined {
  const coordinates = value.trim().split("|");
  if (coordinates.length !== 2 || coordinates.some((coordinate) => !/^\d+$/.test(coordinate))) return undefined;
  const [x, y] = coordinates.map(Number);
  if (x < 0 || x > 200 || y < 0 || y > 200) return undefined;
  const color = XYToRGB(value);
  return [color.r, color.g, color.b];
}

/** Parses an RGB color supplied as six hexadecimal digits, with an optional hash. */
export function parseHexRgb(value: string): [number, number, number] | undefined {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value.trim());
  if (!match) return undefined;
  return [Number.parseInt(match[1], 16), Number.parseInt(match[2], 16), Number.parseInt(match[3], 16)];
}

/** Parses a JSON object payload from a panel event. */
export function recordFromJson(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Returns whether an unknown value is a non-null, non-array object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Provides a trimmed display string or a fallback for missing HA attributes. */
export function displayValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/** Sends one authenticated WebSocket request for each registry command. */
async function homeAssistantWebSocketRequests(baseUrl: string, accessToken: string, commands: string[]): Promise<unknown[]> {
  const url = new URL(normalizeHomeAssistantBaseUrl(baseUrl));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/websocket`;
  url.search = "";
  url.hash = "";

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url.toString(), { handshakeTimeout: 10_000, maxPayload: 2 * 1024 * 1024 });
    const results: unknown[] = [];
    const received = new Set<number>();
    let authenticated = false;
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("Home Assistant registry lookup timed out.")), 10_000);

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      if (error) reject(error);
      else resolve(results);
    };

    socket.on("message", (data) => {
      let message: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(data.toString());
        if (!isRecord(parsed)) throw new Error("Unexpected Home Assistant WebSocket response.");
        message = parsed;
      } catch {
        finish(new Error("Home Assistant returned an invalid WebSocket response."));
        return;
      }

      if (message["type"] === "auth_required") {
        socket.send(JSON.stringify({ type: "auth", access_token: accessToken }));
        return;
      }
      if (message["type"] === "auth_invalid") {
        finish(new Error("Home Assistant rejected the access token."));
        return;
      }
      if (message["type"] === "auth_ok") {
        if (authenticated) return;
        authenticated = true;
        commands.forEach((command, index) => {
          socket.send(JSON.stringify({ id: index + 1, type: command }));
        });
        return;
      }

      const responseId = typeof message["id"] === "number" ? message["id"] : undefined;
      if (!authenticated || responseId === undefined || responseId < 1 || responseId > commands.length) return;
      if (message["type"] !== "result" || message["success"] !== true) {
        finish(new Error("Home Assistant could not return its entity and area registry."));
        return;
      }
      results[responseId - 1] = message["result"];
      received.add(responseId);
      if (received.size === commands.length) finish();
    });

    socket.on("error", () => finish(new Error("Could not connect to the Home Assistant registry WebSocket.")));
    socket.on("close", () => {
      if (!settled) finish(new Error("Home Assistant closed the registry WebSocket."));
    });
  });
}

/** Normalizes the REST host for a matching /api/websocket URL. */
function normalizeHomeAssistantBaseUrl(value: string): string {
  const url = new URL(value.trim());
  if (!(url.protocol === "http:" || url.protocol === "https:") || url.username || url.password || url.search || url.hash) {
    throw new Error("Home Assistant URL must use HTTP or HTTPS and must not include credentials, query parameters, or a fragment.");
  }
  return url.toString().replace(/\/+$/, "");
}

/** Sends a bounded JSON REST request with the configured long-lived access token. */
async function homeAssistantFetch(baseUrl: string, accessToken: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const normalizedBaseUrl = normalizeHomeAssistantBaseUrl(baseUrl);
  if (!accessToken.trim()) throw new Error("Set the Home Assistant access token in the plugin profile.");
  const response = await fetch(`${normalizedBaseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...init.headers
    },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    throw new Error(response.status === 401 || response.status === 403
      ? "Home Assistant rejected the access token. Check the saved token and permissions."
      : `Home Assistant returned HTTP ${response.status}.`);
  }
  if (response.status === 204) return undefined;
  return response.json();
}

/** Sorts entity choices case-insensitively by their friendly name. */
function sortHomeAssistantEntities(entities: HomeAssistantEntityOption[]): HomeAssistantEntityOption[] {
  return entities.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}

/** Validates and maps the small Entity Registry subset used by the picker. */
function parseEntityRegistry(value: unknown): HomeAssistantEntityRegistryEntry[] {
  return asArrayOfRecords(value).flatMap((entry) => {
    if (typeof entry["entity_id"] !== "string") return [];
    return [{
      entity_id: entry["entity_id"],
      area_id: typeof entry["area_id"] === "string" ? entry["area_id"] : null,
      device_id: typeof entry["device_id"] === "string" ? entry["device_id"] : null
    }];
  });
}

/** Validates and maps the Device Registry subset used to inherit area assignments. */
function parseDeviceRegistry(value: unknown): HomeAssistantDeviceRegistryEntry[] {
  return asArrayOfRecords(value).flatMap((entry) => {
    if (typeof entry["id"] !== "string") return [];
    return [{ id: entry["id"], area_id: typeof entry["area_id"] === "string" ? entry["area_id"] : null }];
  });
}

/** Validates and maps the Area Registry subset used to display filter labels. */
function parseAreaRegistry(value: unknown): HomeAssistantAreaRegistryEntry[] {
  return asArrayOfRecords(value).flatMap((entry) => {
    if (typeof entry["id"] !== "string" || typeof entry["name"] !== "string") return [];
    return [{ id: entry["id"], name: entry["name"] }];
  });
}

/** Keeps object items from a registry response and rejects malformed entries. */
function asArrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** Checks an HA RGB attribute for exactly three valid color channels. */
function isRgbColor(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every((channel) =>
    typeof channel === "number" && Number.isFinite(channel) && channel >= 0 && channel <= 255
  );
}
