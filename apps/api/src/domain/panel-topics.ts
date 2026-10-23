import type { Panel } from "../types.js";

type PanelTopicIdentity = Pick<Panel, "nodeName" | "macAddress" | "unifiedFirmware">;

/** Returns the configured topic root used for normal panel commands and events. */
export function panelTopicRoot(panel: PanelTopicIdentity): string {
  return panel.nodeName;
}

/** Returns the stable bootstrap root for initial settings and firmware identity messages. */
export function panelBootstrapTopicRoot(panel: PanelTopicIdentity): string {
  return panel.unifiedFirmware ? unifiedPanelTopicRoot(panel.macAddress) ?? panel.nodeName : panel.nodeName;
}

/** Returns operational and potential unified roots, including during the first OTA boot before promotion. */
export function panelTopicRoots(panel: PanelTopicIdentity): string[] {
  return [...new Set([panel.nodeName, unifiedPanelTopicRoot(panel.macAddress)].filter((root): root is string => Boolean(root)))].sort(
    (left, right) => right.length - left.length
  );
}

/** Returns the unified firmware topic root derived from the last three MAC bytes. */
export function unifiedPanelTopicRoot(macAddress: string | undefined): string | undefined {
  const normalized = normalizeMacAddress(macAddress);
  return normalized ? `nspanel/nspanel-${normalized.slice(-6)}` : undefined;
}

/** Finds which configured root delivered this panel packet. */
export function panelTopicRootForMessage(panel: PanelTopicIdentity, topic: string): string | undefined {
  return panelTopicRoots(panel).find((root) => topic === root || topic.startsWith(`${root}/`));
}

/** Normalizes common ESPHome MAC address formats to twelve lowercase hexadecimal characters. */
export function normalizeMacAddress(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().replace(/[:-]/g, "").toLowerCase();
  return /^[a-f0-9]{12}$/.test(normalized) ? normalized : undefined;
}
