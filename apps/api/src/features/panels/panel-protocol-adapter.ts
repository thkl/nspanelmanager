import type { Panel, PanelBinding } from "../../types.js";
import type { PluginScreen } from "../plugins/plugin-contract.js";

/** Event decoded from the firmware's favorite and universal info-page topics. */
export type PanelInputEvent =
  | { type: "favorite"; index: number }
  | { type: "info-button"; index: number; bindingId: string; action: string }
  | { type: "info-back"; bindingId: string };

/**
 * Encapsulates topic names and JSON envelopes used by the current ESPHome TFT.
 * Plugins and flow code work with screen models and actions; this adapter maps
 * them to the firmware's `cmnd/info` and `event/...` transport contract.
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
    this.publish(`${panel.nodeName}/cmnd/nextion`, "page pageList");
    return this.publish(`${panel.nodeName}/cmnd/info`, JSON.stringify({
      title: screen.title,
      message: screen.message,
      topic: binding.id,
      buttons
    }));
  }

  /** Returns the panel to its home page through the firmware's raw Nextion command topic. */
  exitToHome(panel: Panel): boolean { return this.publish(`${panel.nodeName}/cmnd/nextion`, "page page0"); }

  /** Decodes supported panel event topics and structured payloads into app-level events. */
  decodeEvent(nodeName: string, topic: string, payload: string): PanelInputEvent | undefined {
    const prefix = `${nodeName}/event/`;
    if (!topic.startsWith(prefix)) return undefined;
    const eventTopic = topic.slice(prefix.length);
    const favoriteMatch = /^favorites\/(\d+)$/.exec(eventTopic);
    if (favoriteMatch && payload === "press") return { type: "favorite", index: Number(favoriteMatch[1]) - 1 };
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
