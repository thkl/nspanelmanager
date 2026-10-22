import type { ManagerConfig, MqttRoute, RouteDirection } from "../types.js";

/**
 * Normalizes and validates a user-created MQTT bridge before it is persisted.
 *
 * Source filters may use MQTT subscription wildcards; publish targets may not.
 * External-state routes must name a panel so `{nodeName}` replacement always
 * has a concrete destination instead of accidentally broadcasting to nowhere.
 */
export function normalizeRoute(input: unknown, id = ""): MqttRoute {
  const value = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const direction: RouteDirection = value.direction === "panel-to-external" ? "panel-to-external" : "external-to-panel";
  const payloadFilter = normalizePayloadFilter(value.payloadFilter);
  return {
    id,
    name: stringValue(value.name).trim(),
    direction,
    ...(stringValue(value.panelId) ? { panelId: stringValue(value.panelId) } : {}),
    sourceTopic: stringValue(value.sourceTopic).trim(),
    targetTopic: stringValue(value.targetTopic).trim(),
    payloadTemplate: typeof value.payloadTemplate === "string" ? value.payloadTemplate : "{{payload}}",
    ...(payloadFilter ? { payloadFilter } : {})
  };
}

/** Returns a user-facing validation error, or undefined when the route is valid. */
export function validateRoute(route: MqttRoute, config: ManagerConfig): string | undefined {
  if (!route.name || !route.sourceTopic || !route.targetTopic) return "Name, source topic, and target topic are required.";
  if (route.direction === "external-to-panel" && !route.panelId) return "Choose a target panel for this route.";
  if (route.direction === "external-to-panel" && !config.panels.some((panel) => panel.id === route.panelId)) return "Select an existing panel for this route.";
  if (route.sourceTopic.includes("#") && !route.sourceTopic.endsWith("/#") && route.sourceTopic !== "#") return "The MQTT # wildcard must be the final topic segment.";
  if (route.targetTopic.includes("#") || route.targetTopic.includes("+")) return "MQTT target topics cannot contain wildcards.";
  if (route.payloadFilter?.mode === "contains" && !route.payloadFilter.value) return "Enter text for the payload filter.";
  if (route.payloadFilter?.mode === "json-equals" && (!route.payloadFilter.path || route.payloadFilter.path.split(".").some((part) => !part))) {
    return "Enter a valid JSON path using dot-separated property names.";
  }
  return undefined;
}

function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }

function normalizePayloadFilter(input: unknown): MqttRoute["payloadFilter"] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  if (value.mode === "contains" || value.mode === "equals") {
    return { mode: value.mode, value: stringValue(value.value) };
  }
  if (value.mode === "json-equals") {
    return { mode: "json-equals", path: stringValue(value.path).trim(), value: stringValue(value.value) };
  }
  return undefined;
}
