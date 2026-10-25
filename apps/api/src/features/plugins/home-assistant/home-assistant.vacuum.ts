import type { PanelBinding, ResolvedPluginInstance } from "../../../types.js";
import type { PluginActionResult, PluginFavoritePressResult, PluginScreen, PluginState } from "../plugin-contract.js";
import type { Logger } from "../../../services/logger.js";
import {
  callHomeAssistantService,
  displayValue,
  entityStatePatch,
  getHomeAssistantEntity,
  getHomeAssistantVacuumAreas,
  numberValue
} from "./home-assistant.api.js";

interface VacuumArea {
  id: string;
  name: string;
}

const VACUUM_AREA_PAGE_SIZE = 5;

/**
 * Presents vacuum status, mapped Home Assistant areas, and the available
 * control actions in the manager's plugin info pages.
 */
export class HomeAssistantVacuumControls {
  /** Creates vacuum controls with the manager's structured logger. */
  constructor(private readonly logger: Logger) {}

  /** Opens the info page from a favorite, or starts/pauses from a hardware button. */
  async handleFavoritePress(
    instance: ResolvedPluginInstance,
    binding: PanelBinding,
    entityId: string
  ): Promise<PluginFavoritePressResult> {
    if (binding.id.startsWith("hardware-button:")) {
      return this.runAction(instance, entityId, "start_pause");
    }
    return { screen: "overview", statePatch: await this.loadAreas(instance, entityId) };
  }

  /** Renders vacuum status and available actions in the manager's info screens. */
  renderScreen(instance: ResolvedPluginInstance, state: PluginState, screen: string): PluginScreen | undefined {
    if (screen.startsWith("areas")) return this.renderAreasScreen(instance, state, screen);
    if (screen !== "overview") return undefined;

    const details = [`Status: ${displayValue(state["entityState"], "Unknown")}`];
    const batteryLevel = numberValue(state, "batteryLevel");
    const fanSpeed = displayValue(state["fanSpeed"], "");
    const vacuumError = displayValue(state["vacuumError"], "");
    const areas = readVacuumAreas(state["vacuumAreas"]);
    if (batteryLevel !== undefined) details.push(`Battery: ${Math.round(batteryLevel)}%`);
    if (fanSpeed) details.push(`Fan speed: ${fanSpeed}`);
    if (vacuumError) details.push(`Issue: ${vacuumError}`);
    if (state["vacuumAreaLookup"] === "unavailable") {
      details.push("Cleaning areas: could not load from Home Assistant");
    } else if (state["vacuumAreaLookup"] === "loaded") {
      details.push(`Cleaning areas: ${areas.length} mapped`);
    }

    return {
      title: displayValue(state["entityName"], instance.name),
      message: details.join("\n"),
      buttons: [
        { label: "Start / Pause", action: "vacuum:start_pause" },
        { label: "Return to dock", action: "vacuum:return_to_base" },
        { label: "Locate", action: "vacuum:locate" },
        { label: "Clean area", action: "vacuum:areas" }
      ]
    };
  }

  /** Navigates area pages or calls Home Assistant to clean the selected area. */
  async handleAction(
    instance: ResolvedPluginInstance,
    entityId: string,
    state: PluginState,
    action: string
  ): Promise<PluginActionResult> {
    if (action === "vacuum:areas") {
      return {
        screen: "areas:0",
        statePatch: await this.loadAreas(instance, entityId),
        navigation: { type: "reload" }
      };
    }
    if (action === "vacuum:overview") {
      return { screen: "overview", navigation: { type: "reload" } };
    }

    const pageMatch = /^vacuum:areas-page:(\d+)$/.exec(action);
    if (pageMatch) {
      return { screen: `areas:${Number(pageMatch[1])}`, navigation: { type: "reload" } };
    }

    const areaMatch = /^vacuum:clean-area:(.+)$/.exec(action);
    if (areaMatch) {
      const areaId = decodeAreaId(areaMatch[1]);
      const area = readVacuumAreas(state["vacuumAreas"]).find((candidate) => candidate.id === areaId);
      if (!area) return { screen: "areas:0", navigation: { type: "reload" } };

      await callHomeAssistantService(instance, "vacuum", "clean_area", entityId, {
        cleaning_area_id: [area.id]
      });
      const entity = await getHomeAssistantEntity(instance, entityId);
      return {
        screen: "overview",
        statePatch: {
          ...entityStatePatch(entity),
          vacuumAreas: readVacuumAreas(state["vacuumAreas"]),
          vacuumAreaLookup: "loaded"
        },
        navigation: { type: "reload" }
      };
    }

    const match = /^vacuum:(start_pause|return_to_base|locate)$/.exec(action);
    if (!match) return { screen: "exit" };
    const result = await this.runAction(instance, entityId, match[1]);
    return { screen: "overview", statePatch: result.statePatch };
  }

  /** Loads current HA area mappings whenever the favorite opens. */
  private async loadAreas(instance: ResolvedPluginInstance, entityId: string): Promise<PluginState> {
    try {
      return {
        vacuumAreas: await getHomeAssistantVacuumAreas(instance, entityId),
        vacuumAreaLookup: "loaded"
      };
    } catch (error) {
      this.logger.error("Home Assistant vacuum area lookup failed.", {
        component: "plugin",
        plugin: instance.name,
        phase: "vacuum area lookup",
        entity: entityId,
        detail: error instanceof Error ? error.message : String(error)
      });
      return { vacuumAreas: [], vacuumAreaLookup: "unavailable" };
    }
  }

  /** Renders the mapped-area picker and explains how to configure a missing mapping. */
  private renderAreasScreen(instance: ResolvedPluginInstance, state: PluginState, screen: string): PluginScreen {
    const pageMatch = /^areas(?::(\d+))?$/.exec(screen);
    const areas = readVacuumAreas(state["vacuumAreas"]);
    if (!pageMatch || areas.length === 0) {
      const message = state["vacuumAreaLookup"] === "unavailable"
        ? "Could not read the vacuum's area mapping from Home Assistant."
        : "No areas are mapped yet. Open the vacuum entity settings in Home Assistant and map its segments to areas.";
      return {
        title: "Clean area",
        message,
        buttons: [{ label: "Back", action: "vacuum:overview" }]
      };
    }

    const pageCount = Math.ceil(areas.length / VACUUM_AREA_PAGE_SIZE);
    const pageIndex = Math.min(Number(pageMatch[1] ?? 0), pageCount - 1);
    const start = pageIndex * VACUUM_AREA_PAGE_SIZE;
    const buttons = areas.slice(start, start + VACUUM_AREA_PAGE_SIZE).map((area) => ({
      label: shortenAreaName(area.name),
      action: `vacuum:clean-area:${encodeURIComponent(area.id)}`
    }));
    if (pageIndex > 0) buttons.unshift({ label: "Previous", action: `vacuum:areas-page:${pageIndex - 1}` });
    if (pageIndex < pageCount - 1) buttons.push({ label: "Next", action: `vacuum:areas-page:${pageIndex + 1}` });
    buttons.push({ label: "Back", action: "vacuum:overview" });

    return {
      title: displayValue(state["entityName"], instance.name),
      message: `Choose an area to clean (${pageIndex + 1}/${pageCount}).`,
      buttons
    };
  }

  /** Calls a standard vacuum service and refreshes the cached entity state. */
  private async runAction(instance: ResolvedPluginInstance, entityId: string, action: string): Promise<PluginFavoritePressResult> {
    await callHomeAssistantService(instance, "vacuum", action, entityId);
    const entity = await getHomeAssistantEntity(instance, entityId);
    return { statePatch: entityStatePatch(entity) };
  }
}

/** Validates area options restored from the plugin runtime state cache. */
function readVacuumAreas(value: unknown): VacuumArea[] {
  if (!Array.isArray(value)) return [];
  return value.filter((area): area is VacuumArea => Boolean(area)
    && typeof area === "object"
    && typeof area["id"] === "string"
    && typeof area["name"] === "string");
}

/** Keeps long room labels readable on the panel's small info-page buttons. */
function shortenAreaName(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 18 ? `${trimmed.slice(0, 17)}…` : trimmed;
}

/** Decodes and validates an area ID from a panel button action. */
function decodeAreaId(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value);
    return /^[a-z0-9_-]+$/i.test(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}
