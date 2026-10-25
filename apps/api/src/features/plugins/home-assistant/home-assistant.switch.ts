import type { ResolvedPluginInstance } from "../../../types.js";
import type { PluginFavoritePressResult } from "../plugin-contract.js";
import { callHomeAssistantService, entityStatePatch, getHomeAssistantEntity } from "./home-assistant.api.js";

/**
 * Handles the shared one-tap behavior for simple HA entities such as switches,
 * fans, input booleans, media players, and ordinary light favorite buttons.
 */
export class HomeAssistantSwitchControls {
  /** Toggles one entity and returns the resulting state for the manager cache. */
  async toggle(instance: ResolvedPluginInstance, entityId: string): Promise<PluginFavoritePressResult> {
    await callHomeAssistantService(instance, "homeassistant", "toggle", entityId);
    const entity = await getHomeAssistantEntity(instance, entityId);
    return { statePatch: entityStatePatch(entity) };
  }
}
