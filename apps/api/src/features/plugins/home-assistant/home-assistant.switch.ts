import type { ResolvedPluginInstance } from "../../../types.js";
import type { PluginFavoritePressResult } from "../plugin-contract.js";
import { callHomeAssistantService, entityStatePatch, getHomeAssistantEntity } from "./home-assistant.api.js";

/**
 * Handles the shared one-tap behavior for switches, fans, input booleans, and
 * media players. Home Assistant lights use their brightness-aware controller.
 */
export class HomeAssistantSwitchControls {
  /** Toggles one entity and returns the resulting state for the manager cache. */
  async toggle(instance: ResolvedPluginInstance, entityId: string): Promise<PluginFavoritePressResult> {
    await callHomeAssistantService(instance, "homeassistant", "toggle", entityId);
    // Read the entity back after HA applies the service so cached state reflects the integration's actual result.
    const entity = await getHomeAssistantEntity(instance, entityId);
    return { statePatch: entityStatePatch(entity) };
  }
}
