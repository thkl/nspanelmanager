import type { PluginConfigValue, ResolvedPluginInstance } from "../../types.js";
import type { MqttMessageEnvelope, PluginActionResult, PluginConfigField, PluginDefinition, PluginMenuPage, PluginMenuPageAction, PluginRuntimeContext, PluginScreen, PluginState } from "./plugin-contract.js";

interface FavoritePageEntry {
  label: string;
  topic: string;
  instanceId: string;
}

/**
 * Provides a reusable 12-shortcut menu that can be opened from a panel favorite.
 * Each menu entry launches another configured plugin instance, and the runtime
 * restores this menu when the user presses Back from the launched plugin.
 */
export class FavoritesPagePlugin implements PluginDefinition {
  readonly id = "favorites-page";
  readonly name = "Favorites page";
  readonly version = 1;
  readonly description = "Opens a configurable 12-button menu of plugin instances from a panel favorite.";
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
      maxRows: 12,
      rowHeader: "Button",
      addRowLabel: "Add favorite",
      help: "Choose a label and plugin instance for each shortcut. Empty rows are hidden on the panel.",
      columns: [
        { key: "label", label: "Favorite name" },
        { key: "topic", label: "Topic (optional)"},
        { key: "instanceId", label: "Plugin instance", optionSource: "plugin-instances" }
      ]
    }
  ];

  /** Validates title and requires each configured shortcut to have a label and target. */
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

  /** Supplies the title and configured shortcut labels for the firmware-native menu. */
  renderMenuPage(instance: ResolvedPluginInstance, _context: PluginRuntimeContext): PluginMenuPage {
    const entries = parseEntries(instance.config.entries) ?? [];
    const page = {
      title: stringValue(instance.config.title, "Favorites"),
      buttons: Array.from({ length: 12 }, (_, index) => ({ label: entries[index]?.label ?? "" , topic:entries[index]?.topic ?? "" }))
    };
    console.log(page);
    return page;
  }

  /** Opens the plugin instance configured at the selected menu index. */
  handleMenuPageAction(instance: ResolvedPluginInstance, index: number, _context: PluginRuntimeContext): PluginMenuPageAction | undefined {
    if (!Number.isInteger(index) || index < 0 || index > 11) return undefined;
    const entry = (parseEntries(instance.config.entries) ?? [])[index];
    return entry?.instanceId ? { targetPluginInstanceId: entry.instanceId } : undefined;
  }

  /** This plugin has no generic information screen. */
  renderScreen(_instance: ResolvedPluginInstance, _state: PluginState, _screen: string, _context: PluginRuntimeContext): PluginScreen | undefined { return undefined; }

  /** Generic info-page actions are unused for this firmware-native menu. */
  handleAction(_instance: ResolvedPluginInstance, state: PluginState, _action: string, _context: PluginRuntimeContext): PluginActionResult {
    return { screen: "exit", statePatch: state };
  }
}

/** Serializes twelve blank menu slots for a new Favorites page profile. */
function defaultEntries(): string {
  return JSON.stringify(Array.from({ length: 12 }, () => ({ label: "", instanceId: "" })));
}

/** Reads persisted table rows while filling missing cells with safe empty values. */
function parseEntries(value: PluginConfigValue | undefined): FavoritePageEntry[] | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length > 12) return undefined;
    const entries = parsed.map((row): FavoritePageEntry => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return { label: "", instanceId: "" , topic : ""};
      const source = row as Record<string, unknown>;
      return {
        label: typeof source.label === "string" ? source.label : "",
        topic: typeof source.topic === "string" ? source.topic : "",
        instanceId: typeof source.instanceId === "string" ? source.instanceId : ""
      };
    });
    while (entries.length < 12) entries.push({ label: "", instanceId: "", topic : ""});
    return entries;
  } catch {
    return undefined;
  }
}

/** Returns a configured string setting or a stable display fallback. */
function stringValue(value: PluginConfigValue | undefined, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
