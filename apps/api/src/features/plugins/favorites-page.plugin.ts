import type { PluginConfigValue, ResolvedPluginInstance } from "../../types.js";
import type { MqttMessageEnvelope, PluginActionResult, PluginConfigField, PluginDefinition, PluginMenuPage, PluginMenuPageAction, PluginRuntimeContext, PluginScreen, PluginState } from "./plugin-contract.js";

interface FavoritePageEntry {
  label: string;
  topic: string;
  instanceId: string;
}

const SHORTCUTS_PER_PAGE = 12;
const MAX_SHORTCUT_PAGES = 4;

/**
 * Provides a swipe-paged shortcut menu that can be opened from a panel favorite.
 * Each menu entry launches another configured plugin instance, and the runtime
 * restores this menu and its selected page when the user presses Back.
 */
export class FavoritesPagePlugin implements PluginDefinition {
  readonly id = "favorites-page";
  readonly name = "Favorites page";
  readonly version = 1;
  readonly description = "Opens a configurable menu of plugin shortcuts from a panel favorite, with twelve shortcuts per page.";
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
      help: "Choose a label and plugin instance. Each panel page shows twelve shortcuts; swipe to move between pages.",
      columns: [
        { key: "label", label: "Favorite name" },
        { key: "topic", label: "Topic (optional)"},
        { key: "instanceId", label: "Plugin instance", optionSource: "plugin-instances" }
      ]
    }
  ];

  /** Validates the page title and paired shortcut labels and plugin targets. */
  validateConfig(config: Record<string, PluginConfigValue>): string | undefined {
    const title = typeof config.title === "string" ? config.title.trim() : "";
    if (!title || title.length > 32) return "Enter a page title of 1 to 32 characters.";
    const entries = parseEntries(config.entries);
    if (!entries) return "The favorite shortcuts are invalid. Reopen the editor and configure the rows again.";
    if (entries.some((entry) => Boolean(entry.label.trim()) !== Boolean(entry.instanceId.trim()))) {
      return "Each favorite shortcut needs both a name and a plugin instance, or both fields must be empty.";
    }
    if (entries.some((entry) => entry.label.length > 24)) return "Favorite names must be 24 characters or fewer.";
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
        return { label: entry?.label ?? "", topic: entry?.topic ?? "" };
      })
    };
  }

  /** Opens the plugin instance configured at the selected slot on the active page. */
  handleMenuPageAction(instance: ResolvedPluginInstance, index: number, _context: PluginRuntimeContext, pageIndex = 0): PluginMenuPageAction | undefined {
    if (!Number.isInteger(index) || index < 0 || index >= SHORTCUTS_PER_PAGE) return undefined;
    const entries = parseEntries(instance.config.entries) ?? [];
    const selectedIndex = Math.max(0, Math.trunc(pageIndex)) * SHORTCUTS_PER_PAGE + index;
    const entry = entries[selectedIndex];
    return entry?.instanceId ? { targetPluginInstanceId: entry.instanceId } : undefined;
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
  return JSON.stringify(Array.from({ length: 12 }, () => ({ label: "", instanceId: "" })));
}

/** Reads persisted table rows while filling missing cells with safe empty values. */
function parseEntries(value: PluginConfigValue | undefined): FavoritePageEntry[] | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length > SHORTCUTS_PER_PAGE * MAX_SHORTCUT_PAGES) return undefined;
    const entries = parsed.map((row): FavoritePageEntry => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return { label: "", instanceId: "", topic: "" };
      const source = row as Record<string, unknown>;
      return {
        label: typeof source.label === "string" ? source.label : "",
        topic: typeof source.topic === "string" ? source.topic : "",
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
