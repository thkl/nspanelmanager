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
  return {
    id,
    name: stringValue(value.name).trim(),
    direction,
    ...(stringValue(value.panelId) ? { panelId: stringValue(value.panelId) } : {}),
    sourceTopic: stringValue(value.sourceTopic).trim(),
    targetTopic: stringValue(value.targetTopic).trim(),
    payloadTemplate: typeof value.payloadTemplate === "string" ? value.payloadTemplate : "{{payload}}"
  };
}

/** Returns a user-facing validation error, or undefined when the route is valid. */
export function validateRoute(route: MqttRoute, config: ManagerConfig): string | undefined {
  if (!route.name || !route.sourceTopic || !route.targetTopic) return "Name, source topic, and target topic are required.";
  if (route.direction === "external-to-panel" && !route.panelId) return "Choose a target panel for this route.";
  if (route.direction === "external-to-panel" && !config.panels.some((panel) => panel.id === route.panelId)) return "Select an existing panel for this route.";
  if (route.sourceTopic.includes("#") && !route.sourceTopic.endsWith("/#") && route.sourceTopic !== "#") return "The MQTT # wildcard must be the final topic segment.";
  if (route.targetTopic.includes("#") || route.targetTopic.includes("+")) return "MQTT target topics cannot contain wildcards.";
  return undefined;
}

function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }
