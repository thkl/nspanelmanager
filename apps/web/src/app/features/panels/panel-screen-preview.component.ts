import { Component, effect, input, output, signal, untracked } from "@angular/core";
import type { ManagerConfig, Panel, PluginConfigValue, PluginInstance, PluginPagePreviewResult, PluginProfile } from "../../models";
import { colorFromWheelTouch, type PanelWheelColor } from "./panel-color-wheel";

type PreviewScreen = "home" | "favorites" | "info" | "music" | "thermostat" | "weather" | "level" | "light";
interface PreviewLocation { screen: PreviewScreen; instanceId?: string; title?: string; pageId?: string }
interface PreviewInstance { instance: PluginInstance; profile: PluginProfile }
interface PreviewFavorite { label: string; instanceId: string }
interface PreviewPreset { label: string; value: number }

/**
 * Simulates panel navigation against the unsaved draft and configured plugin
 * instances. Touches update only local preview state and report the MQTT
 * command that would be sent; this component never publishes to the broker.
 * Scripted page rendering uses the separate API preview with a sample message.
 */
@Component({
  selector: "nspanel-screen-preview",
  standalone: true,
  templateUrl: "./panel-screen-preview.component.html",
  styleUrl: "./panel-screen-preview.component.css"
})
export class PanelScreenPreviewComponent {
  readonly panel = input<Panel | null>(null);
  readonly config = input<ManagerConfig | null>(null);
  readonly favoriteAssignments = input<Record<number, string>>({});
  readonly pagePreview = input<PluginPagePreviewResult | null>(null);
  readonly pageButton = output<number>();
  readonly pageBack = output<void>();
  readonly showBack = input(false);
  readonly location = signal<PreviewLocation>({ screen: "home" });
  readonly simulatedLevels = signal<Record<string, number>>({});
  readonly wheelSelection = signal<(PanelWheelColor & { instanceId: string }) | null>(null);
  readonly thermostatTarget = signal(20);
  readonly selectedMusicPlayer = signal(0);
  readonly actionNotice = signal("");
  readonly screens: ReadonlyArray<{ id: PreviewScreen; label: string }> = [
    { id: "home", label: "Home" },
    { id: "favorites", label: "Favorites" },
    { id: "info", label: "Message" },
    { id: "music", label: "Music" },
    { id: "thermostat", label: "Thermostat" },
    { id: "weather", label: "Weather" }
  ];
  private previousPanelId: string | null = null;

  /** Clears transient device state and navigation when another panel is selected. */
  constructor() {
    effect(() => {
      const panelId = this.panel()?.id ?? null;
      if (panelId !== this.previousPanelId) {
        this.previousPanelId = panelId;
        untracked(() => this.reset());
      }
    });
  }

  /** Opens a firmware page directly from the picker. */
  selectScreen(screen: PreviewScreen): void {
    this.location.set({ screen });
    this.actionNotice.set("");
  }

  /** Resets only simulated state; the panel draft is never changed. */
  reset(): void {
    this.location.set({ screen: "home" });
    this.simulatedLevels.set({});
    this.wheelSelection.set(null);
    this.thermostatTarget.set(20);
    this.selectedMusicPlayer.set(0);
    this.actionNotice.set("");
  }

  /** The scripted render preview always uses the firmware's message page. */
  activeScreen(): PreviewScreen { return this.pagePreview() ? "info" : this.location().screen; }

  /** The panel's top-left control on every subpage returns directly to Home. */
  goBack(): void {
    this.location.set({ screen: "home" });
    this.actionNotice.set("");
  }

  /** Opens a panel screen without creating a nested Back path. */
  private navigate(next: PreviewLocation): void {
    this.location.set(next);
    this.actionNotice.set("");
  }

  /** Opens a panel-native screen from a simulated on-screen control. */
  openScreen(screen: PreviewScreen): void { this.navigate({ screen }); }

  /** Resolves a configured plugin instance and its reusable profile. */
  instanceContext(instanceId?: string): PreviewInstance | undefined {
    const instance = this.config()?.pluginInstances.find((item) => item.id === instanceId);
    const profile = this.config()?.pluginProfiles.find((item) => item.id === instance?.pluginProfileId);
    return instance && profile ? { instance, profile } : undefined;
  }

  /** Models the firmware's mode 1 level navigation and other tile toggles. */
  pressHomeTile(index: number): void {
    const button = this.panel()?.settings.buttons[index];
    if (!button) return;
    if (button.mode === 1) this.navigate({ screen: "level", instanceId: button.pluginInstanceId, title: button.label });
    else this.changeDevice(button.pluginInstanceId, "toggle", index);
  }

  /** Simulates the separate tile Up and Down controls in mode 0. */
  pressHomeStep(index: number, direction: 1 | -1): void {
    this.changeDevice(this.panel()?.settings.buttons[index]?.pluginInstanceId, direction === 1 ? "up" : "dn", index);
  }

  /** Opens a configured light's detail controls, as a long press does on HMI. */
  pressHomeLong(index: number): void {
    const button = this.panel()?.settings.buttons[index];
    const context = this.instanceContext(button?.pluginInstanceId);
    if (context?.profile.pluginId === "mqtt-light") this.navigate({ screen: "light", instanceId: context.instance.id, title: button?.label });
    else this.actionNotice.set("This tile has no light control page assigned.");
  }

  /** Reads the visible shortcuts from the panel or a nested Favorites plugin. */
  favorites(): PreviewFavorite[] {
    const context = this.instanceContext(this.location().instanceId);
    if (context?.profile.pluginId === "favorites-page") {
      return this.parseRows(context.profile.config["entries"], 12).map((row) => ({ label: String(row["label"] ?? ""), instanceId: String(row["instanceId"] ?? "") }));
    }
    return (this.panel()?.settings.favorites.buttons ?? []).map((favorite, index) => ({ label: favorite.label, instanceId: this.favoriteAssignments()[index] ?? "" }));
  }

  /** Returns the configured title of the current favorites menu. */
  favoritesTitle(): string {
    const context = this.instanceContext(this.location().instanceId);
    return context?.profile.pluginId === "favorites-page"
      ? this.configString(context.profile.config, "title", "Favorites")
      : this.panel()?.settings.favorites.name || "Favorites";
  }

  /** Follows the plugin binding for a favorite slot. */
  pressFavorite(index: number): void {
    const favorite = this.favorites()[index];
    if (!favorite?.instanceId) { this.actionNotice.set("No plugin instance is assigned to this favorite."); return; }
    const context = this.instanceContext(favorite.instanceId);
    if (!context) { this.actionNotice.set("The assigned plugin instance is unavailable."); return; }
    const pluginId = context.profile.pluginId;
    if (pluginId === "favorites-page") this.navigate({ screen: "favorites", instanceId: favorite.instanceId });
    else if (pluginId === "mqtt-cover") this.navigate({ screen: "level", instanceId: favorite.instanceId, title: favorite.label });
    else if (pluginId === "mqtt-scripted" || pluginId === "mqtt-fan") {
      this.navigate({ screen: "info", instanceId: favorite.instanceId, pageId: this.configString(context.profile.config, "startPage", "overview") });
    } else this.navigate({ screen: "info", instanceId: favorite.instanceId, title: favorite.label });
  }

  /** Shows a scripted page name without running its renderer or MQTT actions. */
  messageTitle(): string {
    if (this.pagePreview()) return this.pagePreview()?.title || "Message page";
    const context = this.instanceContext(this.location().instanceId);
    const page = this.parseRows(context?.profile.config["pages"], 16).find((row) => row["id"] === this.location().pageId);
    return String(page?.["name"] || this.location().title || context?.instance.name || "Message page");
  }

  /** Labels scripted button slots from configured actions until a render exists. */
  messageButtons(): string[] {
    if (this.pagePreview()) return this.pagePreview()?.buttons ?? [];
    const context = this.instanceContext(this.location().instanceId);
    if (!context || !this.location().pageId) return [];
    const actions = this.parseRows(context.profile.config["buttonActions"], 128);
    return Array.from({ length: 8 }, (_, index) => {
      const action = actions.find((row) => row["pageId"] === this.location().pageId && row["slot"] === String(index + 1));
      if (action?.["type"] === "page") return `Open ${action["target"]}`;
      if (action?.["type"] === "mqtt") return "Send MQTT";
      if (action?.["type"] === "function") return `Run ${action["target"]}`;
      return "";
    });
  }

  /** Navigates a scripted page action or reports its command without executing it. */
  pressMessageButton(index: number): void {
    if (this.pagePreview()) { this.pageButton.emit(index); return; }
    const context = this.instanceContext(this.location().instanceId);
    const action = this.parseRows(context?.profile.config["buttonActions"], 128)
      .find((row) => row["pageId"] === this.location().pageId && row["slot"] === String(index + 1));
    if (!action) return;
    if (action["type"] === "page" && typeof action["target"] === "string") this.navigate({ ...this.location(), pageId: action["target"] });
    else if (action["type"] === "mqtt" && context) this.showCommand(context, String(action["topic"] ?? ""), String(action["payload"] ?? ""));
    else if (action["type"] === "function") this.actionNotice.set(`Would run ${action["target"]}. Function actions need the live runtime.`);
  }

  /** Reads the configured eight cover presets for the level page. */
  levelPresets(): PreviewPreset[] {
    const context = this.instanceContext(this.location().instanceId);
    return this.parseRows(context?.profile.config["presets"], 8)
      .filter((row) => typeof row["label"] === "string" && typeof row["value"] === "number")
      .map((row) => ({ label: String(row["label"]), value: Number(row["value"]) }));
  }

  /** Returns the current local simulation value for the open detail page. */
  currentLevel(): number | undefined {
    const id = this.location().instanceId;
    return id ? this.simulatedLevels()[id] : undefined;
  }

  /** Uses the cover profile's actual slider bounds, including non-default ranges. */
  levelMinimum(): number { return this.configNumber(this.instanceContext(this.location().instanceId)?.profile.config ?? {}, "minimum", 0); }
  /** Uses the cover profile's actual slider bounds, including non-default ranges. */
  levelMaximum(): number { return this.configNumber(this.instanceContext(this.location().instanceId)?.profile.config ?? {}, "maximum", 100); }

  /** Simulates one level preset or slider change. */
  setCurrentLevel(value: number): void { this.changeDevice(this.location().instanceId, "set", undefined, value); }

  /** Uses the firmware's four fixed brightness buttons on pageColorLight. */
  setLightBrightness(value: number): void { this.setCurrentLevel(value); }

  /** Uses the firmware's fixed ten-percent brightness step buttons. */
  stepLightBrightness(direction: 1 | -1): void {
    this.setCurrentLevel((this.currentLevel() ?? 0) + direction * 10);
  }

  /** Previews one of the two color scene commands configured on the light. */
  pressLightScene(button: 1 | 2): void {
    const context = this.instanceContext(this.location().instanceId);
    if (!context) { this.actionNotice.set("No light instance is assigned."); return; }
    const settings = context.profile.config;
    const presetName = `PSET${button}`;
    const presetPayload = context.instance.variables[presetName];
    if (presetPayload?.trim()) {
      this.showCommand(context, this.configString(settings, "setTopic"), presetPayload);
      return;
    }
    this.showCommand(context, this.configString(settings, "setTopic"), this.configString(settings, "scenePayloadTemplate", '{"scene":{{button}},"page":"{{page}}"}'), { button: String(button), page: "default" });
  }

  /**
   * Simulates the panel's RGB wheel event at a pointer position, then previews
   * its configured RGB/HSB MQTT payload.
   */
  pickLightColor(event: PointerEvent): void {
    const context = this.instanceContext(this.location().instanceId);
    if (!context) { this.actionNotice.set("No light instance is assigned."); return; }
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const x = Math.max(0, Math.min(220, Math.round((event.clientX - rect.left) / rect.width * 220)));
    const y = Math.max(0, Math.min(220, Math.round((event.clientY - rect.top) / rect.height * 220)));
    const diameter = this.configNumber(context.profile.config, "colorWheelDiameter", 200);
    const color = colorFromWheelTouch(x, y, diameter > 0 ? diameter : 200);
    this.wheelSelection.set({ ...color, instanceId: context.instance.id });
    const settings = context.profile.config;
    const hueDegrees = color.hue;
    const saturationPercent = color.saturation * 100;
    const brightnessPercent = this.currentLevel() ?? 100;
    const hue = this.mapConfiguredRange(hueDegrees, 0, 360, this.configNumber(settings, "hueMinimum", 0), this.configNumber(settings, "hueMaximum", 255));
    const saturation = this.mapConfiguredRange(saturationPercent, 0, 100, this.configNumber(settings, "saturationMinimum", 0), this.configNumber(settings, "saturationMaximum", 255));
    const brightness = this.mqttBrightness(settings, brightnessPercent);
    const payload = this.configString(settings, "colorWheelPayloadTemplate", '{"color":{"hue":{{hue}},"saturation":{{saturation}}},"brightness":{{brightness}},"transition":0.5}');
    this.showCommand(context, this.configString(context.profile.config, "setTopic"), payload, {
      value: `${color.red}|${color.green}|${color.blue}`, rgb: color.rgb,
      red: String(color.red), green: String(color.green), blue: String(color.blue),
      hue: String(Math.round(hue * 100) / 100), hueDegrees: String(Math.round(hueDegrees * 100) / 100), hueFraction: String(Math.round(hueDegrees / 360 * 10_000) / 10_000),
      saturation: String(Math.round(saturation * 100) / 100), saturationPercent: String(Math.round(saturationPercent * 100) / 100),
      saturationFraction: String(Math.round(color.saturation * 10_000) / 10_000),
      brightness: String(brightness), brightnessPercent: String(brightnessPercent)
    });
  }

  /** Keeps the wheel preview responsive while a mouse or touch drag is held. */
  moveLightColor(event: PointerEvent): void {
    if (event.buttons) this.pickLightColor(event);
  }

  /** Simulates thermostat Up/Down using the assigned instance's range and step. */
  changeThermostat(direction: 1 | -1): void {
    const context = this.instanceContext(this.panel()?.nativePluginInstances?.["thermostat"]);
    if (!context) { this.actionNotice.set("Assign a thermostat instance to this panel first."); return; }
    const settings = context.profile.config;
    const minimum = this.configNumber(settings, "minimum", 5);
    const maximum = this.configNumber(settings, "maximum", 30);
    const delta = this.configNumber(settings, "delta", 0.5);
    const value = Math.min(maximum, Math.max(minimum, Math.round((this.thermostatTarget() + delta * direction) * 10) / 10));
    this.thermostatTarget.set(value);
    const payload = this.configString(settings, "temperaturePayloadTemplate", "{{value}}")
      .replaceAll("{{value}}", String(value)).replaceAll("{{temperature}}", String(value));
    this.showCommand(context, this.configString(settings, "setTopic"), payload);
  }

  /** Simulates one Auto or Boost command from the thermostat screen. */
  setThermostatMode(mode: "auto" | "boost"): void {
    const context = this.instanceContext(this.panel()?.nativePluginInstances?.["thermostat"]);
    if (!context) { this.actionNotice.set("Assign a thermostat instance to this panel first."); return; }
    const settings = context.profile.config;
    this.showCommand(context, this.configString(settings, "setTopic"), this.configString(settings, "modePayloadTemplate", "mode:{{mode}}").replaceAll("{{mode}}", mode));
  }

  /** Mirrors the API's music settings list from enabled Sonos plugin instances. */
  musicPlayers(): NonNullable<Panel["settings"]["music"]> {
    const saved = this.panel()?.settings.music;
    if (saved?.length) return saved;
    const config = this.config();
    if (!config) return [];
    return config.pluginInstances.flatMap((instance) => {
      const profile = config.pluginProfiles.find((item) => item.id === instance.pluginProfileId);
      const playerName = instance.variables["playerName"]?.trim();
      const id = Number(instance.variables["playerId"]);
      return instance.enabled && profile?.pluginId === "mqtt-sonos-player" && playerName && Number.isInteger(id) && id >= 0 && id <= 10
        ? [{ id: String(id), name: instance.name, sonos: instance.variables["sonosName"]?.trim() || playerName, player: `sonos/${playerName}` }]
        : [];
    }).sort((left, right) => Number(left.id) - Number(right.id)).slice(0, 8);
  }

  /** Returns the player selected in the simulated music screen. */
  private selectedMusic(): NonNullable<Panel["settings"]["music"]>[number] | undefined {
    return this.musicPlayers()[this.selectedMusicPlayer()];
  }

  /** Chooses Play or Pause using the selected player's displayed track label. */
  pressMusicPlayPause(): void {
    const player = this.selectedMusic();
    if (!player) { this.actionNotice.set("No music player is available in this panel's settings."); return; }
    const track = player.currentSong?.trim().toUpperCase() ?? "";
    const stoppedOrPaused = !track || track === "[STOP]" || track === "[S T O P]" || track === "[PAUSE]";
    this.pressMusic(stoppedOrPaused ? "group.play" : "group.pause");
  }

  /** Simulates the selected Sonos player's configured MQTT command. */
  pressMusic(command: "group.pause" | "group.play" | "group.stop" | "group.next.track" | "group.previous.track" | "group.adjust.volume", payload = ""): void {
    const player = this.selectedMusic();
    if (!player?.player) { this.actionNotice.set("No music player is available in this panel's settings."); return; }
    this.actionNotice.set(`Would publish ${player.player}/cmnd/${command} → ${payload || "(empty payload)"}`);
  }

  /** Shows the firmware's Favorite action event in this local-only preview. */
  pressMusicFavorite(): void {
    const player = this.selectedMusic();
    if (!player) { this.actionNotice.set("No music player is available in this panel's settings."); return; }
    const nodeName = this.panel()?.nodeName || "panel";
    this.actionNotice.set(`Would send ${nodeName}/event/music { cmd: "fav1", player: "${player.id}" }`);
  }

  /** Shows the panel's Join/Leave group control in this local-only preview. */
  pressMusicGroup(): void {
    const player = this.selectedMusic();
    if (!player) { this.actionNotice.set("No music player is available in this panel's settings."); return; }
    const nodeName = this.panel()?.nodeName || "panel";
    this.actionNotice.set(`Would use ${nodeName}/event/music Join/Leave for ${player.name}.`);
  }

  /** Shows the value label that the home tile would receive after a touch. */
  tileValue(instanceId?: string): string {
    const context = this.instanceContext(instanceId);
    const value = instanceId ? this.simulatedLevels()[instanceId] : undefined;
    if (!context || value === undefined) return "—";
    if (context.profile.pluginId === "mqtt-light") {
      if (value === 0) return this.configString(context.profile.config, "zeroValueLabel", "Off");
      if (value === 100) return this.configString(context.profile.config, "fullValueLabel", "On");
      return `${value} %`;
    }
    const minimum = this.configNumber(context.profile.config, "minimum", 0);
    const maximum = this.configNumber(context.profile.config, "maximum", 100);
    if (value === minimum) return this.configString(context.profile.config, "closedValueLabel", "Closed");
    if (value === maximum) return this.configString(context.profile.config, "openValueLabel", "Open");
    return `${value} %`;
  }

  /** Marks a simulated light or cover as active on its favorite and home tile. */
  deviceActive(instanceId?: string): boolean {
    const context = this.instanceContext(instanceId);
    const value = instanceId ? this.simulatedLevels()[instanceId] : undefined;
    if (!context || value === undefined) return false;
    return context.profile.pluginId === "mqtt-cover"
      ? value > this.configNumber(context.profile.config, "minimum", 0)
      : context.profile.pluginId === "mqtt-light" && value > 0;
  }

  /** Calculates a light or cover command using the profile's templates. */
  private changeDevice(instanceId: string | undefined, action: "toggle" | "up" | "dn" | "set", index?: number, requested?: number): void {
    const context = this.instanceContext(instanceId);
    if (!context || !instanceId) { this.actionNotice.set(index === undefined ? "No device instance is assigned." : `Tile ${index + 1} has no plugin instance assigned.`); return; }
    const settings = context.profile.config;
    const previous = this.simulatedLevels()[instanceId];
    let value: number;
    let payload: string;
    if (context.profile.pluginId === "mqtt-light") {
      const step = this.configNumber(settings, "brightnessStep", 10);
      value = action === "toggle" ? previous === 0 || previous === undefined ? 100 : 0
        : Math.max(0, Math.min(100, requested ?? (previous ?? 0) + (action === "up" ? step : -step)));
      payload = action === "toggle"
        ? this.configString(settings, "powerPayloadTemplate", '{"state":"{{value}}"}').replaceAll("{{value}}", value ? "ON" : "OFF")
        : this.configString(settings, "brightnessPayloadTemplate", '{"brightness":{{value}}}').replaceAll("{{value}}", String(this.mqttBrightness(settings, value)));
    } else if (context.profile.pluginId === "mqtt-cover") {
      const minimum = this.configNumber(settings, "minimum", 0);
      const maximum = this.configNumber(settings, "maximum", 100);
      const step = this.configNumber(settings, "delta", 10);
      value = action === "toggle" ? (previous ?? minimum) <= (minimum + maximum) / 2 ? maximum : minimum
        : Math.max(minimum, Math.min(maximum, requested ?? (previous ?? minimum) + (action === "up" ? step : -step)));
      payload = action === "toggle"
        ? this.configString(settings, value === maximum ? "openPayloadTemplate" : "closePayloadTemplate")
        : this.configString(settings, "positionPayloadTemplate", '{"position":{{value}}}').replaceAll("{{value}}", String(value));
    } else { this.actionNotice.set(`The ${context.profile.name} plugin has no preview tile action.`); return; }
    this.simulatedLevels.update((values) => ({ ...values, [instanceId]: value }));
    this.showCommand(context, this.configString(settings, "setTopic"), payload);
  }

  /** Substitutes instance variables into a displayed command without publishing. */
  private showCommand(context: PreviewInstance, topic: string, payload: string, values: Record<string, string> = {}): void {
    const variables = { ...context.instance.variables, ...values };
    const interpolate = (value: string) => value.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_, name: string) => variables[name] ?? `{{${name}}}`);
    this.actionNotice.set(`Would publish ${interpolate(topic)} → ${interpolate(payload)}`);
  }

  /** Parses a bounded JSON table stored as a profile config string. */
  private parseRows(value: PluginConfigValue | undefined, limit: number): Record<string, unknown>[] {
    if (typeof value !== "string") return [];
    try {
      const rows: unknown = JSON.parse(value);
      return Array.isArray(rows) ? rows.slice(0, limit).filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row)) : [];
    } catch { return []; }
  }

  /** Reads one textual plugin setting with a fallback. */
  private configString(config: Record<string, PluginConfigValue>, key: string, fallback = ""): string {
    return typeof config[key] === "string" ? config[key] as string : fallback;
  }

  /** Reads one finite numeric plugin setting with a fallback. */
  private configNumber(config: Record<string, PluginConfigValue>, key: string, fallback: number): number {
    return typeof config[key] === "number" && Number.isFinite(config[key]) ? config[key] as number : fallback;
  }

  /** Maps a value linearly into a configured plugin range. */
  private mapConfiguredRange(value: number, fromMinimum: number, fromMaximum: number, toMinimum: number, toMaximum: number): number {
    const ratio = Math.max(0, Math.min(1, (value - fromMinimum) / (fromMaximum - fromMinimum)));
    return toMinimum + ratio * (toMaximum - toMinimum);
  }

  /** Mirrors the MQTT light plugin's ranged brightness conversion in the preview. */
  private mqttBrightness(config: Record<string, PluginConfigValue>, panelPercent: number): number {
    if (typeof config["brightnessMinimum"] === "number" && typeof config["brightnessMaximum"] === "number") {
      return Math.round(this.mapConfiguredRange(panelPercent, 0, 100, config["brightnessMinimum"], config["brightnessMaximum"]));
    }
    return Math.round(panelPercent / this.configNumber(config, "brightnessFactor", 1));
  }

  /** Formats the optional configured room temperature for the home screen. */
  roomTemperature(): string {
    const value = this.panel()?.settings.currenttemperature;
    return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(1)} °C` : "-- °C";
  }
}
