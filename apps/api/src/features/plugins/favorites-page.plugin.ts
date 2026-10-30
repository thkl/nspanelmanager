import type { PluginConfigValue, PluginVariables, ResolvedPluginInstance } from "../../types.js";
import type { MqttMessageEnvelope, PluginActionResult, PluginConfigField, PluginDefinition, PluginMenuPage, PluginMenuPageAction, PluginRuntimeContext, PluginScreen, PluginState } from "./plugin-contract.js";
import { interpolatePluginTemplate } from "./plugin-variables.js";

interface FavoritePageEntry {
  label: string;
  topic: string;
  payload: string;
  instanceId: string;
}

const SHORTCUTS_PER_PAGE = 12;
const MAX_SHORTCUT_PAGES = 4;

/**
 * Provides a swipe-paged shortcut menu that can be opened from a panel favorite.
 * Each menu entry can publish a templated MQTT command, launch a plugin instance,
 * or do both. The runtime restores this menu and its selected page on Back.
 */
export class FavoritesPagePlugin implements PluginDefinition {
  readonly id = "favorites-page";
  readonly name = "Favorites page";
  readonly version = 2;
  readonly description = "Opens a multi-page shortcut menu with plugin navigation and direct MQTT actions.";
  readonly capabilities = ["panel-menu", "plugin-navigation"];
  readonly favoriteFlow = true;
  readonly configSchema: readonly PluginConfigField[] = [
    { key: "title", label: "Page title", type: "text", required: true, defaultValue: "Favorites", help: "Title shown above the 12 shortcuts." },
    {
      key: "entries",
      label: "Favorite shortcuts",
      type: "table",
      defaultValue: defaultEntries(),
      minRows: 0,
      maxRows: SHORTCUTS_PER_PAGE * MAX_SHORTCUT_PAGES,
      rowHeader: "Button",
      addRowLabel: "Add favorite",
      removeRowBehavior: "clear",
      help: "Choose a plugin instance to navigate, or enter an MQTT topic and payload template to publish directly. Both actions can be combined. Example payload: {\"state\":\"{{state}}\"}. Templates support instance variables and {{panelName}}, {{nodeName}}, {{buttonIndex}}, {{buttonLabel}}, and {{pageNumber}}. Values are inserted as text, so quote string values inside JSON. Each page shows twelve shortcuts; swipe to move between pages.",
      columns: [
        { key: "label", label: "Favorite name" },
        { key: "topic", label: "MQTT topic (optional)" },
        { key: "payload", label: "MQTT payload template", multiline: true },
        { key: "instanceId", label: "Plugin instance", optionSource: "plugin-instances" }
      ]
    }
  ];

  /** Validates page labels and ensures each configured row has a complete action. */
  validateConfig(config: Record<string, PluginConfigValue>): string | undefined {
    const title = typeof config.title === "string" ? config.title.trim() : "";
    if (!title || title.length > 32) return "Enter a page title of 1 to 32 characters.";
    const entries = parseEntries(config.entries);
    if (!entries) return "The favorite shortcuts are invalid. Reopen the editor and configure the rows again.";
    if (entries.some((entry) => entry.label.length > 24)) return "Favorite names must be 24 characters or fewer.";
    for (const entry of entries) {
      const label = entry.label.trim();
      const topic = entry.topic.trim();
      const payload = entry.payload.trim();
      const instanceId = entry.instanceId.trim();
      const hasActionData = Boolean(topic || payload || instanceId);
      if (!label && !hasActionData) continue;
      if (!label) return "Give every configured shortcut a name.";
      if (payload && !topic) return `Favorite '${label}' needs an MQTT topic for its payload.`;
      if (topic && payload && !isPublishableTopicTemplate(topic)) {
        return `Favorite '${label}' needs a valid MQTT publish topic.`;
      }
      if (!instanceId && (!topic || !payload)) {
        return `Favorite '${label}' needs a plugin instance or both an MQTT topic and payload.`;
      }
      if (topic.length > 512) return `The MQTT topic for favorite '${label}' is too long.`;
      if (entry.payload.length > 16_384) return `The MQTT payload template for favorite '${label}' is too long.`;
    }
    return undefined;
  }

  /** This navigation plugin does not subscribe to device MQTT topics. */
  subscriptions(_instance: ResolvedPluginInstance): readonly string[] { return []; }

  /** Menu entries are direct navigation, so there is no incoming device state. */
  decodeMessage(_instance: ResolvedPluginInstance, _message: MqttMessageEnvelope): PluginState | undefined { return undefined; }

  /** Opens the built-in universal menu rather than the generic eight-button page. */
  startScreen(_instance: ResolvedPluginInstance): string { return "favorites"; }

  /** Returns the count of twelve-shortcut pages required by this instance. */
  menuPageCount(instance: ResolvedPluginInstance): number {
    const entries = parseEntries(instance.config.entries) ?? [];
    return Math.max(1, Math.ceil(entries.length / SHORTCUTS_PER_PAGE));
  }

  /** Supplies the title and twelve shortcut labels for one firmware-native menu page. */
  renderMenuPage(instance: ResolvedPluginInstance, _context: PluginRuntimeContext, pageIndex = 0): PluginMenuPage {
    const entries = parseEntries(instance.config.entries) ?? [];
    const pageCount = this.menuPageCount(instance);
    const boundedPageIndex = Math.max(0, Math.min(pageCount - 1, Math.trunc(pageIndex)));
    const firstEntryIndex = boundedPageIndex * SHORTCUTS_PER_PAGE;
    const configuredTitle = stringValue(instance.config.title, "Favorites");
    const pageIndicator = ` ${boundedPageIndex + 1}/${pageCount}`;
    const pageTitle = pageCount > 1
      ? `${configuredTitle.slice(0, Math.max(0, 32 - pageIndicator.length))}${pageIndicator}`
      : configuredTitle;
    // The TFT always receives twelve slots; empty labels clear stale buttons from a previously loaded menu.
    return {
      title: pageTitle,
      pageIndex: boundedPageIndex,
      pageCount,
      buttons: Array.from({ length: SHORTCUTS_PER_PAGE }, (_, index) => {
        const entry = entries[firstEntryIndex + index];
        return { label: entry?.label ?? "" };
      })
    };
  }

  /** Publishes a configured message and/or opens the plugin instance selected at this menu slot. */
  handleMenuPageAction(instance: ResolvedPluginInstance, index: number, context: PluginRuntimeContext, pageIndex = 0): PluginMenuPageAction | undefined {
    if (!Number.isInteger(index) || index < 0 || index >= SHORTCUTS_PER_PAGE) return undefined;
    const entries = parseEntries(instance.config.entries) ?? [];
    const selectedIndex = Math.max(0, Math.trunc(pageIndex)) * SHORTCUTS_PER_PAGE + index;
    const entry = entries[selectedIndex];
    if (!entry) return undefined;

    const variables: PluginVariables = {
      ...context.variables,
      panelName: context.panel.name,
      nodeName: context.panel.nodeName,
      buttonIndex: String(selectedIndex + 1),
      buttonLabel: entry.label,
      pageNumber: String(Math.max(0, Math.trunc(pageIndex)) + 1)
    };
    const commands = entry.topic.trim() && entry.payload.trim()
      ? [{
        topic: interpolatePluginTemplate(entry.topic, variables),
        payload: interpolatePluginTemplate(entry.payload, variables)
      }]
      : [];
    if (commands.some((command) => !isPublishableTopic(command.topic))) {
      throw new Error(`Favorite '${entry.label}' produced an invalid MQTT topic after variable substitution.`);
    }

    const targetPluginInstanceId = entry.instanceId.trim();
    if (!targetPluginInstanceId && commands.length === 0) return undefined;
    return {
      ...(targetPluginInstanceId ? { targetPluginInstanceId } : {}),
      ...(commands.length > 0 ? { commands } : {})
    };
  }

  /** This plugin has no generic information screen. */
  renderScreen(_instance: ResolvedPluginInstance, _state: PluginState, _screen: string, _context: PluginRuntimeContext): PluginScreen | undefined { return undefined; }

  /** Generic info-page actions are unused for this firmware-native menu. */
  handleAction(_instance: ResolvedPluginInstance, state: PluginState, _action: string, _context: PluginRuntimeContext): PluginActionResult {
    return { screen: "exit", statePatch: state };
  }
}

/** Serializes the first twelve blank menu slots for a new Favorites page profile. */
function defaultEntries(): string {
  return JSON.stringify(Array.from({ length: 12 }, () => ({ label: "", topic: "", payload: "", instanceId: "" })));
}

/** Reads persisted table rows while filling missing cells with safe empty values. */
function parseEntries(value: PluginConfigValue | undefined): FavoritePageEntry[] | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length > SHORTCUTS_PER_PAGE * MAX_SHORTCUT_PAGES) return undefined;
    const entries = parsed.map((row): FavoritePageEntry => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return { label: "", instanceId: "", topic: "", payload: "" };
      const source = row as Record<string, unknown>;
      return {
        label: typeof source.label === "string" ? source.label : "",
        topic: typeof source.topic === "string" ? source.topic : "",
        payload: typeof source.payload === "string" ? source.payload : "",
        instanceId: typeof source.instanceId === "string" ? source.instanceId : ""
      };
    });
    return entries;
  } catch {
    return undefined;
  }
}

/** Returns a configured string setting or a stable display fallback. */
function stringValue(value: PluginConfigValue | undefined, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/** Accepts literal publish topics and variable tokens while rejecting MQTT wildcards. */
function isPublishableTopicTemplate(topic: string): boolean {
  const expandedTopic = topic.replace(/\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}/g, "value");
  return isPublishableTopic(expandedTopic);
}

/** Checks a resolved topic before allowing the manager's MQTT publisher to use it. */
function isPublishableTopic(topic: string): boolean {
  return Boolean(topic.trim()) && !/[+#\u0000]/.test(topic);
}
