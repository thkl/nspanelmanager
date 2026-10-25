import type { FavoriteButton, Panel, PanelBinding } from "../../types.js";
import { panelTopicRoot } from "../../domain/panel-topics.js";
import type { PluginScreen } from "../plugins/plugin-contract.js";

/** Event decoded from the firmware's favorite, menu-page, and universal info-page topics. */
export type PanelInputEvent =
  | { type: "hardware-button"; index: 0 | 1; action: "press" | "doubleClick" }
  | { type: "favorite"; index: number }
  | { type: "favorite-longpress"; index: number }
  | { type: "favorite-menu-button"; index: number; bindingId: string }
  | { type: "info-button"; index: number; bindingId: string; action: string }
  | { type: "info-back"; bindingId: string };

/**
 * Encapsulates topic names and JSON envelopes used by the current ESPHome TFT.
 * Plugins and flow code work with screen models and actions; this adapter maps
 * them to the firmware's `cmnd/info`, `cmnd/menupage`, and `event/...` transport contracts.
 */
export class PanelProtocolAdapter {
  /** Creates an adapter that publishes through the manager's shared MQTT client. */
  constructor(private readonly publish: (topic: string, payload: string) => boolean) {}

  /** Displays a plugin screen and pads button entries to avoid stale TFT labels. */
  showScreen(panel: Panel, binding: PanelBinding, screen: PluginScreen): boolean {
    const buttons = Array.from({ length: 8 }, (_, index) => {
      const button = screen.buttons[index];
      return { label: button?.label ?? "", topic: button?.action ?? "" };
    });
    this.publish(`${panelTopicRoot(panel)}/cmnd/nextion`, "page pageList");
    return this.publish(`${panelTopicRoot(panel)}/cmnd/info`, JSON.stringify({
      title: screen.title,
      message: screen.message,
      topic: binding.id,
      buttons
    }));
  }

  /** Shows a plugin-owned 12-button page using the firmware's universal menu screen. */
  showMenuPage(panel: Panel, page: { title: string; buttons: Array<{ label: string, topic?:string }> }): boolean {
    const buttons = Array.from({ length: 12 }, (_, index) => ({ label: page.buttons[index]?.label ?? "",topic: page.buttons[index]?.topic ?? "" }));
    return this.publish(`${panelTopicRoot(panel)}/cmnd/menupage`, JSON.stringify({
      page: { name: page.title, topic: "", buttons }
    }));
  }

  /** Sends favorite labels, per-button bindings, modes, and active state as one menu-page command. */
  showFavoritesPage(
    panel: Panel,
    favorites: { name: string; buttons: FavoriteButton[] },
    bindings: PanelBinding[],
    favoriteState: number
  ): boolean {
    const buttons = Array.from({ length: 12 }, (_, index) => {
      const favorite = favorites.buttons[index];
      const binding = bindings.find((candidate) =>
        candidate.panelId === panel.id &&
        candidate.trigger.type === "favorite" &&
        candidate.trigger.index === index
      );
      return {
        label: favorite?.label ?? "",
        mode: favorite?.mode ?? 0,
        topic: binding?.id ?? ""
      };
    });
    return this.publish(`${panelTopicRoot(panel)}/cmnd/menupage`, JSON.stringify({
      page: { name: favorites.name, topic: "", buttons },
      favorite_bindings: true,
      favstate: favoriteState
    }));
  }

  /** Returns the panel to its home page through the firmware's raw Nextion command topic. */
  exitToHome(panel: Panel): boolean { return this.publish(`${panelTopicRoot(panel)}/cmnd/nextion`, "page page0"); }

  /** Decodes supported panel event topics and structured payloads into app-level events. */
  decodeEvent(nodeName: string, topic: string, payload: string): PanelInputEvent | undefined {
    const prefix = `${nodeName}/event/`;
    if (!topic.startsWith(prefix)) return undefined;
    const eventTopic = topic.slice(prefix.length);
    const hardwareButtonMatch = /^hwbutton\/([01])$/.exec(eventTopic);
    if (hardwareButtonMatch && (payload === "press" || payload === "doubleClick")) {
      return { type: "hardware-button", index: Number(hardwareButtonMatch[1]) as 0 | 1, action: payload };
    }
    const favoriteMatch = /^favorites\/(\d+)$/.exec(eventTopic);
    if (favoriteMatch && payload === "press") return { type: "favorite", index: Number(favoriteMatch[1]) - 1 };
    if (favoriteMatch && payload === "longpress") return { type: "favorite-longpress", index: Number(favoriteMatch[1]) - 1 };
    if (eventTopic === "menupage") {
      let menuEvent: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(payload);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
        menuEvent = parsed as Record<string, unknown>;
      } catch { return undefined; }
      const index = Number(menuEvent.button) - 1;
      if (typeof menuEvent.topic !== "string" || !Number.isInteger(index) || index < 0 || index > 11) return undefined;
      return { type: "favorite-menu-button", index, bindingId: menuEvent.topic };
    }
    const backMatch = /^infobutton\/back$/.exec(eventTopic);
    const buttonMatch = /^infobutton\/(\d+)$/.exec(eventTopic);
    if (!backMatch && !buttonMatch) return undefined;
    let envelope: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(payload);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
      envelope = parsed as Record<string, unknown>;
    } catch { return undefined; }
    if (typeof envelope.topic !== "string") return undefined;
    if (backMatch) return { type: "info-back", bindingId: envelope.topic };
    if (typeof envelope.message !== "string") return undefined;
    return { type: "info-button", index: Number(buttonMatch![1]) - 1, bindingId: envelope.topic, action: envelope.message };
  }
}
