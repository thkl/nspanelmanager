import type { Panel, PluginConfigValue, ResolvedPluginInstance } from "../../types.js";
import type { MqttMessageEnvelope, PluginActionResult, PluginConfigField, PluginDefinition, PluginRuntimeContext, PluginScreen, PluginState } from "./plugin-contract.js";
import { configNumber } from "./plugin-contract.js";

interface WeatherCurrent {
  tempc: number;
  rain: number;
  wind: number;
  condition: string;
}

interface WeatherForecastDay {
  day: string;
  temp: string;
  rain: number;
  wind: number;
  cond: string;
}

interface PanelWeather {
  current: WeatherCurrent;
  forecast: WeatherForecastDay[];
}

/** Font glyphs used by the NSPanel weather page, keyed by OpenWeatherMap icon ID. */
const PANEL_WEATHER_GLYPHS: Readonly<Record<string, { g: string; s: number; a?: string }>> = {
  "01d": { g: "A", s: 1 }, "01n": { g: "B", s: 1, a: "A" },
  "02d": { g: "C", s: 1 }, "02n": { g: "D", s: 1, a: "C" },
  "03d": { g: "E", s: 1 }, "03n": { g: "E", s: 1, a: "E" },
  "04d": { g: "F", s: 1 }, "04n": { g: "F", s: 1, a: "F" },
  "09d": { g: "J", s: 2 }, "09n": { g: "J", s: 2, a: "J" },
  "10d": { g: "I", s: 3 }, "10n": { g: "I", s: 3, a: "I" },
  "11d": { g: "Q", s: 4 }, "11n": { g: "Q", s: 4, a: "Q" },
  "13d": { g: "L", s: 3 }, "13n": { g: "L", s: 3, a: "L" },
  "50d": { g: "G", s: 1 }, "50n": { g: "G", s: 1, a: "G" }
};

/**
 * Fetches current conditions and a five-day forecast from Open-Meteo, then
 * translates its response into the JSON contract consumed by the firmware's
 * built-in weather page. Each instance supplies its own latitude, longitude,
 * and optional IANA timezone so profiles can be shared across locations.
 */
export class OpenMeteoWeatherPlugin implements PluginDefinition {
  readonly id = "open-meteo-weather";
  readonly name = "Open-Meteo weather";
  readonly version = 1;
  readonly description = "Fetch current conditions and a five-day forecast for an NSPanel's built-in weather screen.";
  readonly capabilities = ["weather", "native-panel-page", "http-polling"];
  readonly nativePanelPage = "weather";
  readonly supportsPanelStateReplay = true;
  readonly instanceVariableFields = [
    { key: "latitude", label: "Latitude", required: true, help: "Latitude of this location, between -90 and 90." },
    { key: "longitude", label: "Longitude", required: true, help: "Longitude of this location, between -180 and 180." },
    { key: "timezone", label: "Timezone", help: "Optional IANA timezone such as Europe/Berlin. Leave blank to detect it automatically." }
  ] as const;
  readonly configSchema: readonly PluginConfigField[] = [
    {
      key: "refreshMinutes",
      label: "Refresh interval (minutes)",
      type: "number",
      required: true,
      defaultValue: 30,
      help: "How often the manager checks the weather service. Use 5 to 360 minutes. The panel is updated only when the forecast data changes."
    }
  ];

  /** Validates the service polling interval configured on the reusable profile. */
  validateConfig(config: Record<string, PluginConfigValue>): string | undefined {
    const interval = config.refreshMinutes;
    if (typeof interval !== "number" || !Number.isInteger(interval) || interval < 5 || interval > 360) {
      return "Weather refresh interval must be a whole number between 5 and 360 minutes.";
    }
    return undefined;
  }

  /** Requires valid coordinates and, when supplied, a valid IANA timezone per location. */
  validateInstance(instance: ResolvedPluginInstance): string | undefined {
    const latitude = parseCoordinate(instance.variables.latitude);
    const longitude = parseCoordinate(instance.variables.longitude);
    if (latitude === undefined || latitude < -90 || latitude > 90) return "Set a valid latitude variable between -90 and 90.";
    if (longitude === undefined || longitude < -180 || longitude > 180) return "Set a valid longitude variable between -180 and 180.";

    const timezone = instance.variables.timezone?.trim();
    if (timezone && timezone.toLowerCase() !== "auto") {
      try { new Intl.DateTimeFormat("en", { timeZone: timezone }); }
      catch { return "Set timezone to 'auto' or a valid IANA timezone such as 'Europe/Berlin'."; }
    }
    return undefined;
  }

  /** This service does not subscribe to MQTT topics. */
  subscriptions(_instance: ResolvedPluginInstance): readonly string[] { return []; }

  /** Does not decode MQTT state; weather state comes from the configured web service. */
  decodeMessage(_instance: ResolvedPluginInstance, _message: MqttMessageEnvelope): PluginState | undefined { return undefined; }

  /** Returns the service polling interval in milliseconds. */
  pollIntervalMs(instance: ResolvedPluginInstance): number {
    return configNumber(instance, "refreshMinutes", 30) * 60_000;
  }

  /** Fetches and normalizes the current conditions and five forecast days. */
  async poll(instance: ResolvedPluginInstance, state: PluginState): Promise<PluginState | undefined> {
    const validationError = this.validateInstance(instance);
    if (validationError) throw new Error(validationError);

    const latitude = parseCoordinate(instance.variables.latitude)!;
    const longitude = parseCoordinate(instance.variables.longitude)!;
    const timezone = instance.variables.timezone?.trim() || "auto";
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(latitude));
    url.searchParams.set("longitude", String(longitude));
    url.searchParams.set("current", "temperature_2m,precipitation,wind_speed_10m,weather_code,is_day");
    url.searchParams.set("daily", "weather_code,temperature_2m_min,temperature_2m_max,precipitation_sum,wind_speed_10m_max");
    url.searchParams.set("forecast_days", "5");
    url.searchParams.set("wind_speed_unit", "ms");
    url.searchParams.set("timezone", timezone);

    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Open-Meteo returned HTTP ${response.status}.`);
    const weather = normalizeWeather(await response.json());
    if (JSON.stringify(state.weather) === JSON.stringify(weather)) return undefined;
    return { weather };
  }

  /** Opens the native weather screen if used through a generic panel binding. */
  startScreen(_instance: ResolvedPluginInstance): string { return "weather"; }

  /** The weather integration displays on the firmware's native page. */
  renderScreen(_instance: ResolvedPluginInstance, _state: PluginState, _screen: string, _context: PluginRuntimeContext): PluginScreen | undefined { return undefined; }

  /** The firmware page has no universal plugin actions. */
  handleAction(_instance: ResolvedPluginInstance, state: PluginState, _action: string, _context: PluginRuntimeContext): PluginActionResult {
    return { screen: "exit", statePatch: state };
  }

  /** Tracks the firmware weather page, while weather payloads are cached off-page. */
  nativePanelTransition(_instance: ResolvedPluginInstance, panel: Panel, message: MqttMessageEnvelope): "open" | "close" | undefined {
    if (message.topic === `${panel.nodeName}/event/page/weather`) return "open";
    if (message.topic === `${panel.nodeName}/event/page/page0`) return "close";
    return undefined;
  }

  /** Replays and refreshes the forecast only while the firmware weather page is open. */
  renderNativePanelState(_instance: ResolvedPluginInstance, panel: Panel, state: PluginState): readonly { topic: string; payload: string }[] {
    if (!isPanelWeather(state.weather)) return [];
    return [{ topic: `${panel.nodeName}/cmnd/weather`, payload: JSON.stringify(state.weather) }];
  }

  /** Restores the cached forecast to the panel after its MQTT display starts. */
  renderPanelRestartState(instance: ResolvedPluginInstance, panel: Panel, state: PluginState): readonly { topic: string; payload: string }[] {
    return this.renderNativePanelState(instance, panel, state);
  }
}

function parseCoordinate(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function normalizeWeather(value: unknown): PanelWeather {
  if (!isRecord(value) || !isRecord(value["current"]) || !isRecord(value["daily"])) {
    throw new Error("Open-Meteo returned an incomplete forecast response.");
  }
  const current = value["current"];
  const daily = value["daily"];
  const currentTemperature = finiteNumber(current["temperature_2m"]);
  const currentRain = finiteNumber(current["precipitation"]);
  const currentWind = finiteNumber(current["wind_speed_10m"]);
  const currentCode = finiteNumber(current["weather_code"]);
  const currentIsDay = finiteNumber(current["is_day"]);
  if (currentTemperature === undefined || currentRain === undefined || currentWind === undefined || currentCode === undefined || currentIsDay === undefined) {
    throw new Error("Open-Meteo omitted one or more current weather values.");
  }

  const dates = stringArray(daily["time"]);
  const minimumTemperatures = numberArray(daily["temperature_2m_min"]);
  const maximumTemperatures = numberArray(daily["temperature_2m_max"]);
  const rainAmounts = numberArray(daily["precipitation_sum"]);
  const winds = numberArray(daily["wind_speed_10m_max"]);
  const conditions = numberArray(daily["weather_code"]);
  if (!dates || !minimumTemperatures || !maximumTemperatures || !rainAmounts || !winds || !conditions || dates.length < 5 ||
      [minimumTemperatures, maximumTemperatures, rainAmounts, winds, conditions].some((items) => items.length < 5)) {
    throw new Error("Open-Meteo did not return all five forecast days.");
  }

  return {
    current: {
      tempc: Math.round(currentTemperature),
      rain: roundToOneDecimal(currentRain),
      wind: roundToTwoDecimals(currentWind),
      condition: panelWeatherGlyph(currentCode, currentIsDay === 1)
    },
    forecast: dates.slice(0, 5).map((date, index) => ({
      day: weekday(date),
      temp: `${Math.round(minimumTemperatures[index])}/${Math.round(maximumTemperatures[index])}`,
      rain: roundToOneDecimal(rainAmounts[index]),
      wind: roundToOneDecimal(winds[index]),
      cond: panelWeatherGlyph(conditions[index], true)
    }))
  };
}

/**
 * Translates Open-Meteo WMO codes to the OpenWeatherMap icon IDs used by the
 * panel font map, then returns that map's glyph for current or daytime weather.
 */
function panelWeatherGlyph(wmoCode: number, isDay: boolean): string {
  const openWeatherMapCode = wmoIconCodeForWmoCode(wmoCode);
  if (!openWeatherMapCode) return "";
  const suffix = isDay ? "d" : "n";
  return PANEL_WEATHER_GLYPHS[`${openWeatherMapCode}${suffix}`]?.g ?? "";
}

/** Converts each Open-Meteo WMO weather code to the matching OpenWeatherMap icon category. */
function wmoIconCodeForWmoCode(code: number): string | undefined {
  if (code === 0) return "01";
  if (code === 1) return "01";
  if (code === 2) return "02";
  if (code === 3) return "04";
  if (code === 45 || code === 48) return "50";
  if ([51, 53, 55, 56, 57, 80, 81, 82].includes(code)) return "09";
  if ([61, 63, 65, 66, 67].includes(code)) return "10";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "13";
  if ([95, 96, 99].includes(code)) return "11";
  return undefined;
}

/** Rounds display values while keeping useful decimal precision from the provider. */
function roundToOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Keeps current wind speed precision aligned with the panel weather payload example. */
function roundToTwoDecimals(value: number): number {
  return Math.round(value * 100) / 100;
}

function weekday(date: string): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat("en", { weekday: "short", timeZone: "UTC" }).format(parsed);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "number" && Number.isFinite(item))) return undefined;
  return value as number[];
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
  return value as string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPanelWeather(value: unknown): value is PanelWeather {
  return isRecord(value) && isRecord(value["current"]) && Array.isArray(value["forecast"]);
}
