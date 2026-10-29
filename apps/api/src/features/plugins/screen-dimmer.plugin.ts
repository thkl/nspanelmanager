import type { Panel, PluginConfigValue, ResolvedPluginInstance } from "../../types.js";
import type { MqttMessageEnvelope, PluginActionResult, PluginCommand, PluginConfigField, PluginDefinition, PluginRuntimeContext, PluginScreen, PluginState } from "./plugin-contract.js";

interface PageBrightnessRule {
  page: string;
  brightness: number;
}

/**
 * Applies per-page Nextion brightness settings to one panel. The instance is
 * assigned as a panel event observer, so the manager can react to firmware
 * navigation events without claiming ownership of a native screen.
 */
export class ScreenDimmerPlugin implements PluginDefinition {
  readonly id = "screen-dimmer";
  readonly name = "Screen dimmer";
  readonly version = 1;
  readonly description = "Set the panel display brightness when the firmware reports a page change.";
  readonly capabilities = ["panel-event-observer", "screen-brightness"];
  readonly panelEventObserver = true;
  readonly configSchema: readonly PluginConfigField[] = [
    {
      key: "pageRules",
      label: "Page brightness rules",
      type: "table",
      defaultValue: JSON.stringify([
        { page: "weather", brightness: "10" },
        { page: "page0", brightness: "50" }
      ]),
      columns: [
        { key: "page", label: "Page ID" },
        { key: "brightness", label: "Brightness (0–100)" }
      ],
      minRows: 0,
      maxRows: 32,
      rowHeader: "Page",
      addRowLabel: "Add page rule",
      help: "Match the final part of <panel>/event/page/<pageId>. The configured value is sent as dims=<brightness> to <panel>/cmnd/nextion."
    }
  ];

  /** Validates that each page has one unique ID and an integer brightness in range. */
  validateConfig(config: Record<string, PluginConfigValue>): string | undefined {
    const rules = readRules(config.pageRules);
    if (!rules) return "Enter page brightness rules as a valid table.";
    const usedPages = new Set<string>();
    for (const rule of rules) {
      const page = rule.page.trim();
      if (!/^[A-Za-z0-9_-]+$/.test(page)) return "Each page ID must contain only letters, numbers, underscores, or hyphens.";
      if (usedPages.has(page)) return `The page ID '${page}' has more than one brightness rule.`;
      usedPages.add(page);
      if (!rule.brightness.trim()) return `Enter a brightness value for '${page}'.`;
      const brightness = Number(rule.brightness);
      if (!Number.isInteger(brightness) || brightness < 0 || brightness > 100) {
        return `Brightness for '${page}' must be a whole number between 0 and 100.`;
      }
    }
    return undefined;
  }

  /** This plugin observes panel events and does not subscribe to device topics. */
  subscriptions(_instance: ResolvedPluginInstance): readonly string[] { return []; }

  /** Page events are its only input; no MQTT state model is needed. */
  decodeMessage(_instance: ResolvedPluginInstance, _message: MqttMessageEnvelope): PluginState | undefined { return undefined; }

  /** The dimmer does not render a user-facing page. */
  renderScreen(_instance: ResolvedPluginInstance, _state: PluginState, _screen: string, _context: PluginRuntimeContext): PluginScreen | undefined { return undefined; }

  /** The dimmer has no generic screen actions. */
  handleAction(_instance: ResolvedPluginInstance, state: PluginState, _action: string, _context: PluginRuntimeContext): PluginActionResult {
    return { screen: "exit", statePatch: state };
  }

  /** Publishes the matching Nextion brightness command for an observed page change. */
  handlePanelEvent(instance: ResolvedPluginInstance, panel: Panel, message: MqttMessageEnvelope): readonly PluginCommand[] {
    const pagePrefix = `${panel.nodeName}/event/page/`;
    if (!message.topic.startsWith(pagePrefix)) return [];
    const pageId = message.topic.slice(pagePrefix.length);
    if (!/^[A-Za-z0-9_-]+$/.test(pageId)) return [];

    // Ignore unknown page IDs and invalid brightness rather than issuing a raw Nextion command.
    const rule = readRules(instance.config.pageRules)?.find((candidate) => candidate.page.trim() === pageId);
    if (!rule) return [];
    const brightness = Number(rule.brightness);
    if (!Number.isInteger(brightness) || brightness < 0 || brightness > 100) return [];
    return [{ topic: `${panel.nodeName}/cmnd/nextion`, payload: `dims=${brightness}` }];
  }
}

/** Parses the editor's JSON-backed table into validated page and brightness strings. */
function readRules(value: PluginConfigValue | undefined): Array<{ page: string; brightness: string }> | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return undefined;
    const rules: Array<{ page: string; brightness: string }> = [];
    for (const row of parsed) {
      if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
      const source = row as Record<string, unknown>;
      if (typeof source["page"] !== "string") return undefined;
      const brightness = source["brightness"];
      if (typeof brightness !== "string" && typeof brightness !== "number") return undefined;
      rules.push({ page: source["page"], brightness: String(brightness) });
    }
    return rules;
  } catch {
    return undefined;
  }
}
