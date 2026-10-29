import type { Panel, PanelBinding, ResolvedPluginInstance } from "../../../types.js";
import type {
  MqttMessageEnvelope,
  PluginFavoritePanelPageResult,
  PluginHomeTileResult,
  PluginState
} from "../plugin-contract.js";
import { configNumber } from "../plugin-contract.js";
import {
  callHomeAssistantService,
  clampPercent,
  getHomeAssistantEntity,
  entityStatePatch,
  numberValue,
  requiredEntityId,
  scalarNumber
} from "./home-assistant.api.js";

/**
 * Controls HA covers through panel home tiles and the firmware's native level
 * page. The manager owns event routing; this class maps those events to HA.
 */
export class HomeAssistantCoverControls {
  private readonly presets = [
    { label: "Closed", value: 0 },
    { label: "25%", value: 25 },
    { label: "50%", value: 50 },
    { label: "75%", value: 75 },
    { label: "Open", value: 100 }
  ];

  /** Opens or closes a cover based on its last reported position. */
  async toggle(instance: ResolvedPluginInstance, entityId: string, state: PluginState): Promise<PluginHomeTileResult> {
    const position = numberValue(state, "position");
    // Prefer the numeric position; fall back to HA's open/closed string when the entity has no position attribute.
    const isOpen = position === undefined
      ? String(state["entityState"] ?? "").toLowerCase() === "open"
      : position > 0;
    await callHomeAssistantService(instance, "cover", isOpen ? "close_cover" : "open_cover", entityId);
    return this.refreshState(instance, entityId);
  }

  /** Enters the firmware's level page and sends its presets and current position. */
  openFavoritePanelPage(
    instance: ResolvedPluginInstance,
    panel: Panel,
    binding: PanelBinding,
    state: PluginState
  ): PluginFavoritePanelPageResult {
    const entityId = requiredEntityId(instance);
    return {
      commands: [
        { topic: `${panel.nodeName}/cmnd/goto`, payload: JSON.stringify({ page: "pageLevel" }) },
        this.levelConfiguration(panel, binding.name || instance.name, entityId),
        ...this.renderFavoritePanelState(panel, state)
      ]
    };
  }

  /** Re-sends level presets for a query or applies a slider position change. */
  async handleFavoritePanelEvent(
    instance: ResolvedPluginInstance,
    panel: Panel,
    binding: PanelBinding,
    message: MqttMessageEnvelope,
    state: PluginState
  ): Promise<PluginFavoritePanelPageResult | undefined> {
    const entityId = requiredEntityId(instance);
    const suffix = message.topic.slice(`${panel.nodeName}/event/`.length);
    if (/^level\/\d{1,2}$/.test(suffix) && message.payload.trim().toLowerCase() === "query") {
      return {
        commands: [
          this.levelConfiguration(panel, binding.name || instance.name, entityId),
          ...this.renderFavoritePanelState(panel, state)
        ]
      };
    }
    if (!/^level\/set\/\d{1,2}$/.test(suffix)) return undefined;
    const position = scalarNumber(message.payload);
    if (position === undefined) return undefined;
    return this.setPosition(instance, entityId, position);
  }

  /** Publishes the cached position while the panel's native level page is active. */
  renderFavoritePanelState(panel: Panel, state: PluginState): Array<{ topic: string; payload: string }> {
    const position = numberValue(state, "position");
    if (position === undefined) return [];
    return [{ topic: `${panel.nodeName}/cmnd/level/status`, payload: String(Math.round(position)) }];
  }

  /** Handles one cover home-tile input or native level-page event. */
  async handleTileEvent(
    instance: ResolvedPluginInstance,
    panel: Panel,
    index: number,
    message: MqttMessageEnvelope,
    state: PluginState,
    suffix: string
  ): Promise<PluginHomeTileResult | undefined> {
    const entityId = instance.variables.entityId;
    if (new RegExp(`^level/${index}$`).test(suffix) && message.payload.trim().toLowerCase() === "query") {
      return {
        page: "level",
        commands: [
          this.levelConfiguration(panel, instance.name, entityId),
          ...this.renderFavoritePanelState(panel, state)
        ]
      };
    }
    if (new RegExp(`^level/set/${index}$`).test(suffix)) {
      const position = scalarNumber(message.payload);
      return position === undefined ? undefined : this.setPosition(instance, entityId, position);
    }
    if (!new RegExp(`^item/${index}$`).test(suffix)) return undefined;
    if (message.payload === "toggle") return this.toggle(instance, entityId, state);
    if (message.payload === "up" || message.payload === "dn") {
      const current = numberValue(state, "position") ?? (message.payload === "up" ? 0 : 100);
      const step = configNumber(instance, "coverPositionStep", 10);
      const delta = message.payload === "up" ? step : -step;
      return this.setPosition(instance, entityId, current + delta);
    }
    if (message.payload === "stop") {
      await callHomeAssistantService(instance, "cover", "stop_cover", entityId);
      return this.refreshState(instance, entityId);
    }
    return undefined;
  }

  /** Renders a cover's current position as a home-tile label or slider value. */
  renderHomeTileState(panel: Panel, index: number, page: "home" | "light" | "level", state: PluginState) {
    const position = numberValue(state, "position");
    if (page === "level") {
      return position === undefined
        ? []
        : [{ topic: `${panel.nodeName}/cmnd/level/status`, payload: String(Math.round(position)) }];
    }
    if (page !== "home" || position === undefined) return [];
    const label = position === 0 ? "Closed" : position === 100 ? "Open" : `${Math.round(position)} %`;
    return [{ topic: `${panel.nodeName}/cmnd/status`, payload: JSON.stringify({ [index]: { label } }) }];
  }

  /** Sets the cover's position with Home Assistant's zero-to-one-hundred scale. */
  private async setPosition(instance: ResolvedPluginInstance, entityId: string, requested: number): Promise<PluginHomeTileResult> {
    const position = clampPercent(requested);
    await callHomeAssistantService(instance, "cover", "set_cover_position", entityId, { position });
    return this.refreshState(instance, entityId);
  }

  /** Reads the entity after a service call so the manager stores HA's actual state. */
  private async refreshState(instance: ResolvedPluginInstance, entityId: string): Promise<PluginHomeTileResult> {
    const entity = await getHomeAssistantEntity(instance, entityId);
    return { statePatch: entityStatePatch(entity) };
  }

  /** Builds the manager's firmware-native level-page configuration message. */
  private levelConfiguration(panel: Panel, title: string, entityId: string) {
    return {
      topic: `${panel.nodeName}/cmnd/level/config`,
      payload: JSON.stringify({
        name: title,
        settings: this.presets,
        levelTopic: entityId,
        topic: "",
        version: "2"
      })
    };
  }
}
