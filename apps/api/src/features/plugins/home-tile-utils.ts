import type { PluginConfigValue, ResolvedPluginInstance } from "../../types.js";
import type { PluginCommand } from "./plugin-contract.js";
import { interpolatePluginTemplate } from "./plugin-variables.js";

/** Reads a text field from a plugin profile with a safe fallback. */
export function tileConfigString(instance: ResolvedPluginInstance, key: string, fallback = ""): string {
  const value = instance.config[key];
  return typeof value === "string" ? value : fallback;
}

/** Reads a numeric field from a plugin profile with a safe fallback. */
export function tileConfigNumber(instance: ResolvedPluginInstance, key: string, fallback: number): number {
  const value = instance.config[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Validates configured MQTT topic templates while allowing instance variables. */
export function isTopicTemplateValid(topic: string, filter = false): boolean {
  const normalized = topic.replace(/\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}/g, "variable");
  if (!normalized || normalized.includes("\u0000") || normalized.includes("//")) return false;
  const levels = normalized.split("/");
  return levels.every((level, index) => {
    if (!level.includes("+") && !level.includes("#")) return true;
    if (!filter) return false;
    return level === "+" || (level === "#" && index === levels.length - 1);
  });
}

/** Resolves profile and instance variables plus action values into plain text. */
export function tileTemplate(instance: ResolvedPluginInstance, template: string, values: Record<string, string>): string {
  return interpolatePluginTemplate(template, { ...instance.variables, ...values });
}

/** Resolves one configured MQTT command and returns nothing when it is invalid. */
export function tileCommand(instance: ResolvedPluginInstance, topicTemplate: string, payloadTemplate: string, values: Record<string, string> = {}): PluginCommand | undefined {
  const topic = tileTemplate(instance, topicTemplate, values);
  if (!isTopicTemplateValid(topic)) return undefined;
  return { topic, payload: tileTemplate(instance, payloadTemplate, values) };
}

/** Reads a dot-separated path from JSON, or the root value when the path is blank. */
export function readPayloadValue(payload: string, valuePath: string): unknown {
  let parsed: unknown;
  try { parsed = JSON.parse(payload); } catch { return payload; }
  if (!valuePath.trim()) return parsed;
  return valuePath.split(".").reduce<unknown>((current, part) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[part];
  }, parsed);
}

/** Converts supported JSON scalar values to a finite number. */
export function scalarNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/** Converts common MQTT on/off encodings into a boolean. */
export function scalarPower(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["on", "true", "1", "open", "opened"].includes(normalized)) return true;
  if (["off", "false", "0", "closed", "close"].includes(normalized)) return false;
  return undefined;
}

/** Validates that an editable plugin text setting is present when required. */
export function isConfiguredString(config: Record<string, PluginConfigValue>, key: string): boolean {
  return typeof config[key] === "string" && Boolean((config[key] as string).trim());
}

/** Escapes text used inside a raw Nextion command string. */
export function escapeNextionText(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', "\\\"").replaceAll("\r", " ").replaceAll("\n", " ");
}
