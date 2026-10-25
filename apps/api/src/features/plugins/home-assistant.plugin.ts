import type { Panel, PanelBinding, PluginConfigValue, ResolvedPluginInstance } from "../../types.js";
import type { MqttMessageEnvelope, PluginActionResult, PluginConfigField, PluginDefinition, PluginFavoritePressResult, PluginRuntimeContext, PluginScreen, PluginState } from "./plugin-contract.js";
import { configNumber, configString } from "./plugin-contract.js";

const TOGGLEABLE_DOMAINS = new Set(["fan", "input_boolean", "light", "media_player", "switch"]);

interface HomeAssistantEntity {
  entity_id: string;
  state: string;
  attributes?: { friendly_name?: string };
}

export interface HomeAssistantEntityOption {
  entityId: string;
  name: string;
  state: string;
  domain: string;
}

/** Controls selected Home Assistant entities through its REST API. */
export class HomeAssistantPlugin implements PluginDefinition {
  readonly id = "home-assistant";
  readonly name = "Home Assistant";
  readonly version = 1;
  readonly description = "Select Home Assistant lights, switches, fans, and media players, then toggle them from favorites or hardware buttons.";
  readonly capabilities = ["home-assistant", "favorite-toggle"];
  readonly favoriteFlow = true;
  readonly instanceVariableFields = [
    { key: "entityId", label: "Home Assistant entity", required: true, help: "Choose a supported entity from the Home Assistant profile.", optionSource: "home-assistant-entities" }
  ] as const;
  readonly configSchema: readonly PluginConfigField[] = [
    { key: "baseUrl", label: "Home Assistant URL", type: "text", required: true, defaultValue: "http://homeassistant.local:8123", help: "Manager-reachable Home Assistant base URL, including its scheme and port." },
    { key: "accessToken", label: "Long-lived access token", type: "password", required: true, secret: true, defaultValue: "", help: "Create a Home Assistant long-lived access token. Leave blank when editing to keep the saved token." },
    { key: "pollSeconds", label: "State refresh interval (seconds)", type: "number", required: true, defaultValue: 60, help: "How often the manager checks this entity for state changes (15–3,600 seconds)." }
  ];

  /** Checks the Home Assistant URL, token, and entity polling interval. */
  validateConfig(config: Record<string, PluginConfigValue>): string | undefined {
    if (!validHomeAssistantBaseUrl(stringValue(config, "baseUrl"))) return "Enter a valid Home Assistant HTTP or HTTPS base URL without credentials, query parameters, or a fragment.";
    if (!stringValue(config, "accessToken").trim()) return "Enter a Home Assistant long-lived access token.";
    const pollSeconds = config["pollSeconds"];
    if (typeof pollSeconds !== "number" || !Number.isInteger(pollSeconds) || pollSeconds < 15 || pollSeconds > 3600) {
      return "State refresh interval must be a whole number between 15 and 3,600 seconds.";
    }
    return undefined;
  }

  /** Requires an entity selected from the supported Home Assistant domains. */
  validateInstance(instance: ResolvedPluginInstance): string | undefined {
    const entityId = instance.variables.entityId?.trim() ?? "";
    if (!isToggleableEntityId(entityId)) return "Choose a Home Assistant light, switch, input boolean, fan, or media player.";
    return undefined;
  }

  /** This integration receives its state through HTTP polling, not MQTT. */
  subscriptions(_instance: ResolvedPluginInstance): readonly string[] {
    return [];
  }

  /** Does not decode MQTT state. */
  decodeMessage(_instance: ResolvedPluginInstance, _message: MqttMessageEnvelope): PluginState | undefined {
    return undefined;
  }

  /** Polls the selected entity at the configured interval. */
  pollIntervalMs(instance: ResolvedPluginInstance): number {
    return configNumber(instance, "pollSeconds", 60) * 1000;
  }

  /** Reads the current entity state and caches only changes. */
  async poll(instance: ResolvedPluginInstance, state: PluginState): Promise<PluginState | undefined> {
    const entity = await getHomeAssistantEntity(instance, requiredEntityId(instance));
    const nextState = entityStatePatch(entity);
    return JSON.stringify(state) === JSON.stringify({ ...state, ...nextState }) ? undefined : nextState;
  }

  /** Shows an active indicator while the selected entity is on or playing. */
  favoriteStateActive(_instance: ResolvedPluginInstance, state: PluginState): boolean | undefined {
    return typeof state["isOn"] === "boolean" ? state["isOn"] : undefined;
  }

  /** Toggles the selected Home Assistant entity from a favorite shortcut. */
  async handleFavoritePress(instance: ResolvedPluginInstance, _panel: Panel, _binding: PanelBinding, _state: PluginState, _context: PluginRuntimeContext): Promise<PluginFavoritePressResult> {
    const entityId = requiredEntityId(instance);
    await toggleHomeAssistantEntity(instance, entityId);
    const entity = await getHomeAssistantEntity(instance, entityId);
    return { statePatch: entityStatePatch(entity) };
  }

  /** No plugin-owned information page is used by this toggle-only integration. */
  renderScreen(_instance: ResolvedPluginInstance, _state: PluginState, _screen: string, _context: PluginRuntimeContext): PluginScreen | undefined {
    return undefined;
  }

  /** The integration has no generic page actions. */
  handleAction(_instance: ResolvedPluginInstance, _state: PluginState, _action: string, _context: PluginRuntimeContext): PluginActionResult {
    return { screen: "exit" };
  }
}

/** Lists selectable, toggle-capable Home Assistant entities for a configured profile. */
export async function fetchHomeAssistantEntityOptions(baseUrl: string, accessToken: string): Promise<HomeAssistantEntityOption[]> {
  const response = await homeAssistantFetch(baseUrl, accessToken, "/api/states");
  if (!Array.isArray(response)) throw new Error("Home Assistant returned an invalid entity list.");
  return response
    .filter((entity): entity is HomeAssistantEntity => isRecord(entity) && isToggleableEntityId(entity["entity_id"]))
    .map((entity) => {
      const entityId = entity.entity_id;
      const domain = entityId.split(".")[0];
      const friendlyName = entity.attributes?.friendly_name;
      return {
        entityId,
        name: typeof friendlyName === "string" && friendlyName.trim() ? friendlyName.trim() : entityId,
        state: typeof entity.state === "string" ? entity.state : "unknown",
        domain
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}

function requiredEntityId(instance: ResolvedPluginInstance): string {
  const entityId = instance.variables.entityId?.trim() ?? "";
  if (!isToggleableEntityId(entityId)) throw new Error("Choose a supported Home Assistant entity for this instance.");
  return entityId;
}

async function getHomeAssistantEntity(instance: ResolvedPluginInstance, entityId: string): Promise<HomeAssistantEntity> {
  const encodedEntityId = entityId.split(".").map(encodeURIComponent).join(".");
  const value = await homeAssistantFetch(configString(instance, "baseUrl"), configString(instance, "accessToken"), `/api/states/${encodedEntityId}`);
  if (!isRecord(value) || typeof value["entity_id"] !== "string" || typeof value["state"] !== "string") {
    throw new Error(`Home Assistant returned invalid state for ${entityId}.`);
  }
  return value as unknown as HomeAssistantEntity;
}

async function toggleHomeAssistantEntity(instance: ResolvedPluginInstance, entityId: string): Promise<void> {
  await homeAssistantFetch(configString(instance, "baseUrl"), configString(instance, "accessToken"), "/api/services/homeassistant/toggle", {
    method: "POST",
    body: JSON.stringify({ entity_id: entityId })
  });
}

function entityStatePatch(entity: HomeAssistantEntity): PluginState {
  const state = entity.state.trim().toLowerCase();
  return {
    isOn: ["on", "playing", "buffering"].includes(state),
    entityState: entity.state,
    entityName: typeof entity.attributes?.friendly_name === "string" ? entity.attributes.friendly_name : entity.entity_id,
    available: state !== "unavailable" && state !== "unknown"
  };
}

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

function validHomeAssistantBaseUrl(value: string): boolean {
  try {
    normalizeHomeAssistantBaseUrl(value);
    return true;
  } catch {
    return false;
  }
}

function normalizeHomeAssistantBaseUrl(value: string): string {
  const url = new URL(value.trim());
  if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password || url.search || url.hash) {
    throw new Error("Home Assistant URL must use HTTP or HTTPS and must not include credentials, query parameters, or a fragment.");
  }
  return url.toString().replace(/\/+$/, "");
}

function stringValue(config: Record<string, PluginConfigValue>, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value : "";
}

function isToggleableEntityId(value: unknown): value is string {
  if (typeof value !== "string" || !/^[a-z_][a-z0-9_]*\.[a-z0-9_]+$/i.test(value)) return false;
  return TOGGLEABLE_DOMAINS.has(value.split(".")[0].toLowerCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
