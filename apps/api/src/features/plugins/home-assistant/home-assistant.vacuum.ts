import type { PanelBinding, ResolvedPluginInstance } from "../../../types.js";
import type { PluginActionResult, PluginFavoritePressResult, PluginScreen, PluginState } from "../plugin-contract.js";
import {
  callHomeAssistantService,
  displayValue,
  entityStatePatch,
  getHomeAssistantEntity,
  numberValue
} from "./home-assistant.api.js";

/**
 * Presents vacuum state in the manager's plugin info page and maps its buttons
 * to Home Assistant's start/pause, return-to-base, and locate services.
 */
export class HomeAssistantVacuumControls {
  /** Opens the info page from a favorite, or starts/pauses from a hardware button. */
  async handleFavoritePress(
    instance: ResolvedPluginInstance,
    binding: PanelBinding,
    entityId: string
  ): Promise<PluginFavoritePressResult> {
    if (!binding.id.startsWith("hardware-button:")) return { screen: "overview" };
    return this.runAction(instance, entityId, "start_pause");
  }

  /** Renders vacuum status and available actions in the manager's info screen. */
  renderScreen(instance: ResolvedPluginInstance, state: PluginState, screen: string): PluginScreen | undefined {
    if (screen !== "overview") return undefined;
    const details = [`Status: ${displayValue(state["entityState"], "Unknown")}`];
    const batteryLevel = numberValue(state, "batteryLevel");
    const fanSpeed = displayValue(state["fanSpeed"], "");
    const vacuumError = displayValue(state["vacuumError"], "");
    if (batteryLevel !== undefined) details.push(`Battery: ${Math.round(batteryLevel)}%`);
    if (fanSpeed) details.push(`Fan speed: ${fanSpeed}`);
    if (vacuumError) details.push(`Issue: ${vacuumError}`);

    return {
      title: displayValue(state["entityName"], instance.name),
      message: details.join("\n"),
      buttons: [
        { label: "Start / Pause", action: "vacuum:start_pause" },
        { label: "Return to dock", action: "vacuum:return_to_base" },
        { label: "Locate", action: "vacuum:locate" }
      ]
    };
  }

  /** Runs a known vacuum info-page action and stays on the refreshed overview. */
  async handleAction(instance: ResolvedPluginInstance, entityId: string, action: string): Promise<PluginActionResult> {
    const match = /^vacuum:(start_pause|return_to_base|locate)$/.exec(action);
    if (!match) return { screen: "exit" };
    const result = await this.runAction(instance, entityId, match[1]);
    return { screen: "overview", statePatch: result.statePatch };
  }

  /** Calls a vacuum service and reads its latest state for the manager cache. */
  private async runAction(instance: ResolvedPluginInstance, entityId: string, action: string): Promise<PluginFavoritePressResult> {
    await callHomeAssistantService(instance, "vacuum", action, entityId);
    const entity = await getHomeAssistantEntity(instance, entityId);
    return { statePatch: entityStatePatch(entity) };
  }
}
