import type { Panel, PluginConfigValue, ResolvedPluginInstance } from "../../types.js";
import type { MqttMessageEnvelope, PluginActionResult, PluginDefinition, PluginNativePanelInstanceState, PluginNativePanelResult, PluginScreen, PluginState } from "./plugin-contract.js";

const SONOS_TOPIC_PREFIX = "sonos";
const MUSIC_PLAYER_ID_MIN = 0;
const MUSIC_PLAYER_ID_MAX = 10;

interface SonosState {
  title: string;
  artist: string;
  album: string;
  playbackState: "playing" | "paused_playback" | "stopped";
  artUri: string;
  isCoordinator: boolean;
}

/**
 * Bridges a Sonos MQTT relay to the panel's built-in music screen. Each
 * configured instance represents one player; instances of this plugin share
 * a page and the runtime combines their cached states while that page is open.
 * Playback commands are translated back to the matching player's MQTT topics.
 */
export class MqttSonosPlugin implements PluginDefinition {
  readonly id = "mqtt-sonos-player";
  readonly name = "MQTT Sonos player";
  readonly version = 1;
  readonly description = "Connect a Sonos room through an existing MQTT bridge. Create one instance per player; the built-in music screen lists all configured players and sends controls to the selected room.";
  readonly capabilities = ["mqtt", "native-panel-page", "sonos", "shared-player-page"];
  readonly nativePanelPage = "music";
  readonly nativePanelSharedInstances = true;
  readonly nativePanelStateUpdatesWhenClosed = true;
  readonly configSchema: readonly [] = [];
  readonly instanceVariableFields = [
    { key: "playerName", label: "MQTT player name", required: true, help: "Topic segment in sonos/<playerName>/state and sonos/<playerName>/cmnd/...." },
    { key: "sonosName", label: "Sonos player label", help: "Optional Sonos name for cmnd/settings; defaults to the MQTT player name." },
    { key: "playerId", label: "Music player ID", required: true, help: "Unique integer from 0 to 10. The firmware uses this ID to route music-page button events to this room." }
  ] as const;

  /** Profiles have no shared fields; player identity is stored per instance. */
  validateConfig(_config: Record<string, PluginConfigValue>): string | undefined { return undefined; }

  /** Requires a safe MQTT topic segment and a unique firmware player ID. */
  validateInstance(instance: ResolvedPluginInstance): string | undefined {
    const playerName = playerNameFor(instance);
    if (!playerName) return "Set the playerName instance variable to the Sonos room name.";
    if (/[\/#+\u0000-\u001f]/.test(playerName)) return "playerName must be one MQTT topic part without slashes, wildcards, or control characters.";
    const playerId = playerIdFor(instance);
    if (playerId === undefined) return `Set playerId to a whole number from ${MUSIC_PLAYER_ID_MIN} to ${MUSIC_PLAYER_ID_MAX}.`;
    return undefined;
  }

  /** Subscribes to the state message for this configured room. */
  subscriptions(instance: ResolvedPluginInstance): readonly string[] {
    const playerName = playerNameFor(instance);
    return playerName ? [`${SONOS_TOPIC_PREFIX}/${playerName}/state`] : [];
  }

  /** Converts the relay's room status packet into a small normalized state object. */
  decodeMessage(instance: ResolvedPluginInstance, message: MqttMessageEnvelope): PluginState | undefined {
    const playerName = playerNameFor(instance);
    if (!playerName || message.topic !== `${SONOS_TOPIC_PREFIX}/${playerName}/state`) return undefined;
    const state = parseSonosState(message.payload);
    return state ? { ...state } : undefined;
  }

  /** Uses the firmware-owned page rather than a universal plugin info page. */
  startScreen(_instance: ResolvedPluginInstance): string { return "music"; }

  /** Sonos is displayed on the panel's built-in music page. */
  renderScreen(_instance: ResolvedPluginInstance, _state: PluginState, _screen: string): PluginScreen | undefined { return undefined; }

  /** Native page events carry the selected ID and the music command from firmware. */
  handleAction(_instance: ResolvedPluginInstance, state: PluginState, _action: string): PluginActionResult {
    return { screen: "exit", statePatch: state };
  }

  /** Opens the shared page on music navigation and closes it when firmware returns home. */
  nativePanelTransition(_instance: ResolvedPluginInstance, panel: Panel, message: MqttMessageEnvelope): "open" | "close" | undefined {
    if (message.topic === `${panel.nodeName}/event/page/music`) return "open";
    if (message.topic === `${panel.nodeName}/event/page/page0`) return "close";
    return undefined;
  }

  /** Stores the selected player ID or translates transport controls for the matching player. */
  handleNativePanelEvent(instance: ResolvedPluginInstance, panel: Panel, message: MqttMessageEnvelope): PluginNativePanelResult | void {
    if (message.topic === `${panel.nodeName}/event/page/music`) {
      const selectedPlayerId = parsePlayerId(message.payload);
      return selectedPlayerId === undefined ? undefined : { statePatch: { selectedPlayerId } };
    }
    if (message.topic !== `${panel.nodeName}/event/music`) return undefined;

    const event = parseMusicEvent(message.payload);
    if (!event || event.playerId !== playerIdFor(instance)) return undefined;
    const command = musicCommand(event.command, playerNameFor(instance)!);
    return command ? { commands: [command] } : undefined;
  }

  /** Builds the complete room list and selected-room metadata for the panel. */
  renderNativePanelState(
    instance: ResolvedPluginInstance,
    panel: Panel,
    state: PluginState,
    relatedInstances: readonly PluginNativePanelInstanceState[] = []
  ): readonly { topic: string; payload: string }[] {
    const entries = relatedInstances.length > 0
      ? relatedInstances
      : [{ instance, state }];
    const players = entries
      .filter(({ instance: candidate }) => candidate.pluginId === instance.pluginId)
      .map(({ instance: candidate, state: candidateState }) => ({
        id: playerIdFor(candidate),
        name: candidate.name,
        state: playerState(candidateState),
        hasState: hasSonosPlaybackState(candidateState)
      }))
      .filter((player): player is { id: number; name: string; state: SonosState; hasState: boolean } => player.id !== undefined && Boolean(player.name))
      .sort((left, right) => left.id - right.id);
    const status = players.map(({ name, state: player }) => ({
      player: hmiSafeText(name),
      currenttrack: currentTrackLabel(player),
      currentstate: playbackStateCode(player.playbackState),
      isCoordinator: player.isCoordinator
    }));
    const selectedId = finiteNumber(state.selectedPlayerId);
    const selected = players.find((player) => player.id === selectedId);
    const selectedState = selected?.hasState ? selected.state : undefined;

    const commands = [
      { topic: `${panel.nodeName}/cmnd/music`, payload: JSON.stringify({ status }) },
    ];
    if (selectedState) {
      commands.push({
        topic: `${panel.nodeName}/cmnd/music/state`,
        payload: JSON.stringify({
          title: currentSongTitle(selectedState),
          state: selectedState.playbackState === "playing",
          isCoordinator: selectedState.isCoordinator
        })
      });
    }
    return commands;
  }
}

function playerNameFor(instance: ResolvedPluginInstance): string {
  return instance.variables.playerName?.trim() ?? "";
}

function playerIdFor(instance: ResolvedPluginInstance): number | undefined {
  return parsePlayerId(instance.variables.playerId);
}

function parsePlayerId(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const id = Number(value);
  return Number.isInteger(id) && id >= MUSIC_PLAYER_ID_MIN && id <= MUSIC_PLAYER_ID_MAX ? id : undefined;
}

function parseSonosState(payload: string): SonosState | undefined {
  let value: unknown;
  try { value = JSON.parse(payload); } catch { return undefined; }
  if (!isRecord(value)) return undefined;
  const playbackState = value["playbackstate"];
  if (playbackState !== "playing" && playbackState !== "paused_playback" && playbackState !== "stopped") return undefined;
  return {
    title: stringValue(value["title"]),
    artist: stringValue(value["artist"]),
    album: stringValue(value["album"]),
    playbackState,
    artUri: stringValue(value["artUri"]),
    isCoordinator: typeof value["isCoordinator"] === "boolean" ? value["isCoordinator"] : false
  };
}

function parseMusicEvent(payload: string): { command: string; playerId: number } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    // This firmware currently formats the control event with single quotes.
    const command = /['"]cmd['"]\s*:\s*['"]([^'"]+)['"]/.exec(payload)?.[1];
    const player = /['"]player['"]\s*:\s*['"]?(\d+)['"]?/.exec(payload)?.[1];
    const playerId = parsePlayerId(player);
    return command && playerId !== undefined ? { command, playerId } : undefined;
  }
  if (!isRecord(value)) return undefined;
  const command = stringValue(value["cmd"]);
  const playerId = parsePlayerId(value["player"]);
  return command && playerId !== undefined ? { command, playerId } : undefined;
}

function musicCommand(action: string, playerName: string): { topic: string; payload: string } | undefined {
  const topic = `${SONOS_TOPIC_PREFIX}/${playerName}/cmnd/`;
  switch (action) {
    case "play": return { topic: `${topic}group.play`, payload: "" };
    case "pause": return { topic: `${topic}group.pause`, payload: "" };
    case "stop": return { topic: `${topic}group.stop`, payload: "" };
    case "next": return { topic: `${topic}group.next.track`, payload: "" };
    case "prev": return { topic: `${topic}group.previous.track`, payload: "" };
    case "volup": return { topic: `${topic}group.adjust.volume`, payload: "1" };
    case "voldn": return { topic: `${topic}group.adjust.volume`, payload: "-1" };
    default: return undefined;
  }
}

function playerState(value: PluginState): SonosState {
  const playbackState = value["playbackState"];
  return {
    title: stringValue(value["title"]),
    artist: stringValue(value["artist"]),
    album: stringValue(value["album"]),
    playbackState: playbackState === "playing" || playbackState === "paused_playback" ? playbackState : "stopped",
    artUri: stringValue(value["artUri"]),
    isCoordinator: value["isCoordinator"] === true
  };
}

/** Distinguishes a decoded player status from the default empty runtime state. */
function hasSonosPlaybackState(value: PluginState): boolean {
  return value["playbackState"] === "playing" || value["playbackState"] === "paused_playback" || value["playbackState"] === "stopped";
}

function currentTrackLabel(state: SonosState): string {
  if (state.playbackState === "paused_playback") return "[PAUSE]";
  if (state.playbackState === "stopped") return "[STOP]";
  const title = hmiSafeText(state.title);
  const artist = hmiSafeText(state.artist);
  const strLabel = title && artist ? `${artist} | ${title}` : title ?? artist ?? "[STOP]"
  return strLabel;
}

function currentSongTitle(state: SonosState): string {
  const title = hmiSafeText(state.title);
  const artist = hmiSafeText(state.artist);
  return title && artist ? `${artist} | ${title}` : title || artist;
}

function playbackStateCode(state: SonosState["playbackState"]): number {
  return state === "playing" ? 1 : state === "paused_playback" ? 2 : 0;
}

function hmiSafeText(value: string): string {
  return value.replaceAll('"', "'").replaceAll("\\", " ").replace(/[\r\n\u0000-\u001f]/g, " ").trim();
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
