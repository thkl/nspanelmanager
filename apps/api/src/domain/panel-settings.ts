import { defaultPanelSettings, type PanelSettings } from "../types.js";

/**
 * Converts untrusted HTTP input into the settings shape consumed by firmware.
 *
 * The NSPanel YAML expects fixed-size arrays for four home tiles and twelve
 * favorites. This normalizer limits their lengths, supplies missing entries,
 * keeps only known fields, and clamps bounded numeric controls before the
 * configuration is saved or published to MQTT.
 */
export function normalizePanelSettings(input: unknown, fallbackName: string): PanelSettings {
  const defaults = defaultPanelSettings(fallbackName);
  if (!input || typeof input !== "object") return defaults;
  const settings = input as Record<string, unknown>;
  const buttons = Array.isArray(settings.buttons) ? settings.buttons.slice(0, 4) : defaults.buttons;
  while (buttons.length < 4) buttons.push({ label: "", image: "", mode: 0 });
  const rawFavorites = settings.favorites && typeof settings.favorites === "object" ? settings.favorites as Record<string, unknown> : {};
  const favorites = Array.isArray(rawFavorites.buttons) ? rawFavorites.buttons.slice(0, 12) : defaults.favorites.buttons;
  while (favorites.length < 12) favorites.push({ label: "" });
  const rawHardwareButtons = settings.hwbuttons && typeof settings.hwbuttons === "object" ? settings.hwbuttons as Record<string, unknown> : undefined;
  const hwbuttons = {
    "0": boundedNumber(rawHardwareButtons?.["0"], 0, 1, 0),
    "1": boundedNumber(rawHardwareButtons?.["1"], 0, 1, 0)
  };
  const music = Array.isArray(settings.music) ? settings.music.slice(0, 8).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const player = item as Record<string, unknown>;
    return typeof player.name === "string" && typeof player.id === "number" && Number.isFinite(player.id) ? [{ name: player.name, id: player.id }] : [];
  }) : undefined;
  return {
    panelname: stringValue(settings.panelname) || fallbackName,
    currenttemperature: numericValue(settings.currenttemperature),
    brightness: boundedNumber(settings.brightness, 0, 100, 100),
    screensaver: boundedNumber(settings.screensaver, 0, 1, 0),
    roomstatus: numericValue(settings.roomstatus),
    nightmode: boundedNumber(settings.nightmode, 0, 1, 0),
    buttons: buttons.map((item) => {
      const button = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return { label: stringValue(button.label), image: stringValue(button.image), mode: boundedNumber(button.mode, 0, 1, 0), ...(stringValue(button.labelvalue) ? { labelvalue: stringValue(button.labelvalue) } : {}) };
    }),
    favorites: {
      name: stringValue(rawFavorites.name) || "Favorites",
      buttons: favorites.map((item) => {
        const button = item && typeof item === "object" ? item as Record<string, unknown> : {};
        return { label: stringValue(button.label), ...(button.mode === undefined ? {} : { mode: boundedNumber(button.mode, 0, 1, 0) }) };
      })
    },
    hwbuttons,
    ...(music ? { music } : {})
  };
}

/** Returns a valid simple MQTT node name suitable for topic prefixes. */
export function validNodeName(value: string): boolean { return /^[a-zA-Z0-9_-]+$/.test(value); }

function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }
function numericValue(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function boundedNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = numericValue(value);
  return number === undefined ? fallback : Math.min(max, Math.max(min, number));
}
