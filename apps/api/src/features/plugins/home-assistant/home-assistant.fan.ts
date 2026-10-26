import type { PanelBinding, ResolvedPluginInstance } from "../../../types.js";
import type { PluginActionResult, PluginFavoritePressResult, PluginScreen, PluginState } from "../plugin-contract.js";
import {
  callHomeAssistantService,
  clampPercent,
  displayValue,
  entityStatePatch,
  getHomeAssistantEntity,
  numberValue
} from "./home-assistant.api.js";

const PRESET_PAGE_SIZE = 5;
const MAX_SCREEN_BUTTONS = 8;

/**
 * Provides a detail screen for Home Assistant fans and exposes the controls
 * supported by each selected entity, including percentage, presets, swing,
 * and direction where Home Assistant reports them.
 */
export class HomeAssistantFanControls {
  /** Opens fan controls from a favorite; physical hardware buttons still toggle directly. */
  async handleFavoritePress(
    instance: ResolvedPluginInstance,
    binding: PanelBinding,
    entityId: string,
    state: PluginState
  ): Promise<PluginFavoritePressResult> {
    if (binding.id.startsWith("hardware-button:")) {
      return this.toggle(instance, entityId, state);
    }
    return { screen: "overview" };
  }

  /** Renders the fan status and only the controls supported by this entity. */
  renderScreen(instance: ResolvedPluginInstance, state: PluginState, screen: string): PluginScreen | undefined {
    if (screen.startsWith("presets")) return this.renderPresetsScreen(instance, state, screen);
    if (screen !== "overview") return undefined;

    const details = [`Status: ${displayValue(state["entityState"], "Unknown")}`];
    const percentage = numberValue(state, "fanPercentage");
    const preset = displayValue(state["fanPresetMode"], "");
    const direction = displayValue(state["fanDirection"], "");
    if (percentage !== undefined) details.push(`Speed: ${Math.round(percentage)}%`);
    if (preset) details.push(`Preset: ${preset}`);
    if (typeof state["fanOscillating"] === "boolean") {
      details.push(`Oscillation: ${state["fanOscillating"] ? "On" : "Off"}`);
    }
    if (direction) details.push(`Direction: ${direction}`);

    const buttons: PluginScreen["buttons"] = [
      { label: state["isOn"] === true ? "Turn off" : "Turn on", action: "fan:toggle" }
    ];
    if (state["fanSupportsPercentage"] === true || percentage !== undefined) {
      buttons.push({ label: "Slower", action: "fan:percentage:down" });
      buttons.push({ label: "Faster", action: "fan:percentage:up" });
    }
    if (readPresetModes(state["fanPresetModes"]).length > 0) {
      buttons.push({ label: "Presets", action: "fan:presets" });
    }
    if (typeof state["fanOscillating"] === "boolean" || state["fanSupportsOscillation"] === true) {
      buttons.push({
        label: state["fanOscillating"] === true ? "Swing off" : "Swing on",
        action: "fan:oscillate"
      });
    }
    if (typeof state["fanDirection"] === "string" || state["fanSupportsDirection"] === true) {
      buttons.push({
        label: state["fanDirection"] === "reverse" ? "Forward" : "Reverse",
        action: "fan:direction"
      });
    }

    return {
      title: displayValue(state["entityName"], instance.name),
      message: details.join("\n"),
      buttons: buttons.slice(0, MAX_SCREEN_BUTTONS)
    };
  }

  /** Executes a fan control, refreshes Home Assistant state, and returns to its overview. */
  async handleAction(
    instance: ResolvedPluginInstance,
    entityId: string,
    state: PluginState,
    action: string
  ): Promise<PluginActionResult> {
    if (action === "fan:presets") {
      return { screen: "presets:0", navigation: { type: "reload" } };
    }
    if (action === "fan:overview") {
      return { screen: "overview", navigation: { type: "reload" } };
    }

    const pageMatch = /^fan:preset-page:(\d+)$/.exec(action);
    if (pageMatch) {
      return { screen: `presets:${Number(pageMatch[1])}`, navigation: { type: "reload" } };
    }

    if (action === "fan:toggle") {
      const result = await this.toggle(instance, entityId, state);
      return { screen: "overview", statePatch: result.statePatch };
    }
    if (action === "fan:percentage:up" || action === "fan:percentage:down") {
      await this.changePercentage(instance, entityId, state, action.endsWith(":up") ? 1 : -1);
      return this.refreshOverview(instance, entityId);
    }
    if (action === "fan:oscillate") {
      await callHomeAssistantService(instance, "fan", "oscillate", entityId, {
        oscillating: state["fanOscillating"] !== true
      });
      return this.refreshOverview(instance, entityId);
    }
    if (action === "fan:direction") {
      const nextDirection = state["fanDirection"] === "reverse" ? "forward" : "reverse";
      await callHomeAssistantService(instance, "fan", "set_direction", entityId, { direction: nextDirection });
      return this.refreshOverview(instance, entityId);
    }

    const presetMatch = /^fan:preset:(.+)$/.exec(action);
    if (presetMatch) {
      const preset = decodePreset(presetMatch[1]);
      if (!preset || !readPresetModes(state["fanPresetModes"]).includes(preset)) {
        return { screen: "presets:0", navigation: { type: "reload" } };
      }
      await callHomeAssistantService(instance, "fan", "set_preset_mode", entityId, { preset_mode: preset });
      return this.refreshOverview(instance, entityId);
    }

    return { screen: "exit" };
  }

  /** Toggles the fan using its domain service and reads the resulting state. */
  private async toggle(
    instance: ResolvedPluginInstance,
    entityId: string,
    state: PluginState
  ): Promise<PluginFavoritePressResult> {
    const service = state["isOn"] === true ? "turn_off" : "turn_on";
    await callHomeAssistantService(instance, "fan", service, entityId);
    const entity = await getHomeAssistantEntity(instance, entityId);
    return { statePatch: entityStatePatch(entity) };
  }

  /** Changes fan speed by the reported step, falling back to ten percent. */
  private async changePercentage(
    instance: ResolvedPluginInstance,
    entityId: string,
    state: PluginState,
    direction: 1 | -1
  ): Promise<void> {
    const current = numberValue(state, "fanPercentage") ?? 0;
    const reportedStep = numberValue(state, "fanPercentageStep");
    const step = reportedStep !== undefined && reportedStep > 0 ? reportedStep : 10;
    const target = clampPercent(current + step * direction);
    if (target === 0) {
      await callHomeAssistantService(instance, "fan", "turn_off", entityId);
      return;
    }
    await callHomeAssistantService(instance, "fan", "set_percentage", entityId, { percentage: target });
  }

  /** Reads current entity data after a service call and refreshes the info screen. */
  private async refreshOverview(instance: ResolvedPluginInstance, entityId: string): Promise<PluginActionResult> {
    const entity = await getHomeAssistantEntity(instance, entityId);
    return { screen: "overview", statePatch: entityStatePatch(entity) };
  }

  /** Renders a paginated picker for the entity's available fan preset modes. */
  private renderPresetsScreen(instance: ResolvedPluginInstance, state: PluginState, screen: string): PluginScreen {
    const pageMatch = /^presets(?::(\d+))?$/.exec(screen);
    const presets = readPresetModes(state["fanPresetModes"]);
    if (!pageMatch || presets.length === 0) {
      return {
        title: "Fan presets",
        message: "This fan does not report any preset modes.",
        buttons: [{ label: "Back", action: "fan:overview" }]
      };
    }

    const pageCount = Math.ceil(presets.length / PRESET_PAGE_SIZE);
    const pageIndex = Math.min(Number(pageMatch[1] ?? 0), pageCount - 1);
    const start = pageIndex * PRESET_PAGE_SIZE;
    const buttons = presets.slice(start, start + PRESET_PAGE_SIZE).map((preset) => ({
      label: shortenPresetName(preset),
      action: `fan:preset:${encodeURIComponent(preset)}`
    }));
    if (pageIndex > 0) buttons.unshift({ label: "Previous", action: `fan:preset-page:${pageIndex - 1}` });
    if (pageIndex < pageCount - 1) buttons.push({ label: "Next", action: `fan:preset-page:${pageIndex + 1}` });
    buttons.push({ label: "Back", action: "fan:overview" });

    return {
      title: displayValue(state["entityName"], instance.name),
      message: `Choose a preset (${pageIndex + 1}/${pageCount}).`,
      buttons: buttons.slice(0, MAX_SCREEN_BUTTONS)
    };
  }
}

/** Returns preset names from the cached Home Assistant state. */
function readPresetModes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((mode): mode is string => typeof mode === "string" && mode.trim().length > 0);
}

/** Keeps preset labels short enough for the panel's compact info-page buttons. */
function shortenPresetName(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 18 ? `${trimmed.slice(0, 17)}…` : trimmed;
}

/** Decodes a selected preset label from a panel action token. */
function decodePreset(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}
