import type { Panel, PluginConfigValue, ResolvedPluginInstance } from "../../types.js";
import type { MqttMessageEnvelope, PluginActionResult, PluginDefinition, PluginNativePanelInstanceState, PluginNativePanelResult, PluginScreen, PluginState } from "./plugin-contract.js";

const SONOS_TOPIC_PREFIX = "sonos";
const MUSIC_PLAYER_ID_MIN = 0;
const MUSIC_PLAYER_ID_MAX = 10;

interface SonosState {
  title: string;
  artist: string;
  playbackState: "playing" | "paused_playback" | "stopped";
  /** Unknown until the household status packet identifies this player. */
  isCoordinator?: boolean;
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

  /** Subscribes to this room's playback state and the household coordinator list. */
  subscriptions(instance: ResolvedPluginInstance): readonly string[] {
    const playerName = playerNameFor(instance);
    return playerName
      ? [`${SONOS_TOPIC_PREFIX}/${playerName}/state`, `${SONOS_TOPIC_PREFIX}/household/state`]
      : [];
  }

  /** Requests the household snapshot after MQTT connects so Leave can check coordinator status immediately. */
  onMqttConnected(_instances: readonly ResolvedPluginInstance[], publish: (topic: string, payload: string) => boolean): void {
    publish(`${SONOS_TOPIC_PREFIX}/household/get`, "{}");
  }

  /** Normalizes room playback packets and caches this room's coordinator flag from household state. */
  decodeMessage(instance: ResolvedPluginInstance, message: MqttMessageEnvelope, currentState: PluginState = {}): PluginState | undefined {
    const playerName = playerNameFor(instance);
    if (!playerName) return undefined;
    if (message.topic === `${SONOS_TOPIC_PREFIX}/household/state`) {
      const householdState = householdStateFor(instance, message.payload);
      if (!householdState) return undefined;
      const changed = Object.fromEntries(
        Object.entries(householdState).filter(([key, value]) => currentState[key] !== value)
      );
      return Object.keys(changed).length > 0 ? changed : undefined;
    }
    if (message.topic !== `${SONOS_TOPIC_PREFIX}/${playerName}/state`) return undefined;
    const state = parseSonosState(message.payload);
    if (!state) return undefined;
    const changed = Object.fromEntries(
      Object.entries(state).filter(([key, value]) => currentState[key] !== value)
    );
    return Object.keys(changed).length > 0 ? changed : undefined;
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

  /** Routes music controls by the firmware player ID to the matching configured player instance. */
  nativePanelEventTargets(
    instances: readonly ResolvedPluginInstance[],
    panel: Panel,
    message: MqttMessageEnvelope
  ): readonly ResolvedPluginInstance[] | undefined {
    if (message.topic !== `${panel.nodeName}/event/music`) return undefined;
    const event = parseMusicEvent(message.payload);
    if (!event) return [];
    const target = instances.find((candidate) => candidate.enabled && playerIdFor(candidate) === event.playerId);
    return target ? [target] : [];
  }

  /** Stores the selected player ID or translates transport controls for the routed player instance. */
  handleNativePanelEvent(
    instance: ResolvedPluginInstance,
    panel: Panel,
    message: MqttMessageEnvelope,
    state: PluginState,
    relatedInstances: readonly ResolvedPluginInstance[] = []
  ): PluginNativePanelResult | void {
    if (message.topic === `${panel.nodeName}/event/page/music`) {
      const selectedPlayerId = parsePlayerId(message.payload);
      return selectedPlayerId === undefined ? undefined : { statePatch: { selectedPlayerId } };
    }
    if (message.topic !== `${panel.nodeName}/event/music`) return undefined;

    const event = parseMusicEvent(message.payload);
    const playerName = playerNameFor(instance);
    if (!event || event.playerId !== playerIdFor(instance) || !playerName) return undefined;
    if (event.command === "leave") {
      // Sonos cannot make a coordinator standalone while its group still has members.
      // Wait for a known household status and ignore the request if this room coordinates.
      if (state["isCoordinator"] !== false) return undefined;
      return { commands: [{ topic: `${SONOS_TOPIC_PREFIX}/${playerName}/cmnd/player.become.standalone`, payload: "{}" }] };
    }
    if (event.command === "join") {
      const coordinator = event.groupId === undefined
        ? undefined
        : relatedInstances.find((candidate) => playerIdFor(candidate) === event.groupId);
      const coordinatorName = coordinator ? playerNameFor(coordinator) : "";
      if (!coordinatorName) return undefined;
      return {
        commands: [{
          topic: `${SONOS_TOPIC_PREFIX}/${playerName}/cmnd/player.join.group`,
          payload: coordinatorName
        }]
      };
    }
    const command = musicCommand(event.command, playerName);
    return command ? { commands: [command] } : undefined;
  }

  /** Sends one full, player-ID-keyed snapshot so shared panels can keep each room's state separate. */
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
        state: playerState(candidateState)
      }))
      .filter((player): player is { id: number; name: string; state: SonosState } => player.id !== undefined && Boolean(player.name))
      .sort((left, right) => left.id - right.id);
    if (players.length === 0) return [];
    const status = players.map(({ id, name, state: playerState }) => ({
      playerid: id,
      player: hmiSafeText(name),
      currenttrack: currentTrackLabel(playerState),
      currentstate: playbackStateCode(playerState.playbackState),
      ...(typeof playerState.isCoordinator === "boolean" ? { isCoordinator: playerState.isCoordinator } : {})
    }));
    return [{
      topic: `${panel.nodeName}/cmnd/music`,
      payload: JSON.stringify({ status })
    }];
  }
}

function playerNameFor(instance: ResolvedPluginInstance): string {
  return instance.variables.playerName?.trim() ?? "";
}

function nameFor(instance: ResolvedPluginInstance): string {
  return instance.variables.name?.trim() ?? "";
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
  const state: SonosState = {
    title: stringValue(value["title"]),
    artist: stringValue(value["artist"]),
    playbackState
  };
  if (typeof value["isCoordinator"] === "boolean") state.isCoordinator = value["isCoordinator"];
  return state;
}

function parseMusicEvent(payload: string): { command: string; playerId: number; groupId?: number } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    // This firmware currently formats the control event with single quotes.
    const command = /['"](?:cmd|action)['"]\s*:\s*['"]([^'"]+)['"]/.exec(payload)?.[1];
    const player = /['"]player['"]\s*:\s*['"]?(\d+)['"]?/.exec(payload)?.[1];
    const group = /['"]group['"]\s*:\s*['"]?(\d+)['"]?/.exec(payload)?.[1];
    const playerId = parsePlayerId(player);
    const groupId = parsePlayerId(group);
    return command && playerId !== undefined
      ? { command, playerId, ...(groupId === undefined ? {} : { groupId }) }
      : undefined;
  }
  if (!isRecord(value)) return undefined;
  const command = stringValue(value["cmd"]) || stringValue(value["action"]);
  const playerId = parsePlayerId(value["player"]);
  const groupId = parsePlayerId(value["group"]);
  return command && playerId !== undefined
    ? { command, playerId, ...(groupId === undefined ? {} : { groupId }) }
    : undefined;
}

function musicCommand(action: string, playerName: string): { topic: string; payload: string } | undefined {
  const topic = `${SONOS_TOPIC_PREFIX}/${playerName}/cmnd/`;
  switch (action) {
    case "play": return { topic: `${topic}group.play`, payload: "" };
    case "pause": return { topic: `${topic}group.pause`, payload: "" };
    case "stop": return { topic: `${topic}group.stop`, payload: "" };
    case "next": return { topic: `${topic}group.next.track`, payload: "" };
    case "prev": return { topic: `${topic}group.previous.track`, payload: "" };
    case "volup": return { topic: `${topic}player.adjust.volume`, payload: "1" };
    case "voldn": return { topic: `${topic}player.adjust.volume`, payload: "-1" };
    default: return undefined;
  }
}

function playerState(value: PluginState): SonosState {
  const playbackState = value["playbackState"];
  const state: SonosState = {
    title: stringValue(value["title"]),
    artist: stringValue(value["artist"]),
    playbackState: playbackState === "playing" || playbackState === "paused_playback" ? playbackState : "stopped"
  };
  if (typeof value["isCoordinator"] === "boolean") state.isCoordinator = value["isCoordinator"];
  return state;
}

/** Finds this configured player in the cached household list and normalizes its display state. */
function householdStateFor(instance: ResolvedPluginInstance, payload: string): PluginState | undefined {
  let value: unknown;
  try { value = JSON.parse(payload); } catch { return undefined; }
  if (!Array.isArray(value)) return undefined;

  const aliases = [
    playerNameFor(instance),
    instance.variables.sonosName ?? "",
    instance.name
  ].map(normalizePlayerName).filter(Boolean);
  const player = value.find((entry) => {
    if (!isRecord(entry)) return false;
    const candidate = normalizePlayerName(stringValue(entry["player"]));
    return candidate !== "" && aliases.includes(candidate);
  });
  if (!isRecord(player)) return undefined;

  const patch: PluginState = {};
  if (typeof player["isCoordinator"] === "boolean") patch["isCoordinator"] = player["isCoordinator"];
  if (typeof player["currenttrack"] === "string") {
    patch["title"] = player["currenttrack"];
    patch["artist"] = "";
    const playbackState = householdPlaybackState(player["currentstate"], player["currenttrack"]);
    if (playbackState) patch["playbackState"] = playbackState;
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

/** Maps the compact household status fields to the normalized playback states used by the plugin. */
function householdPlaybackState(currentState: unknown, currentTrack: string): SonosState["playbackState"] | undefined {
  const stateCode = typeof currentState === "number" ||
    typeof currentState === "string" && currentState.trim() !== ""
    ? Number(currentState)
    : Number.NaN;
  if (stateCode === 1) return "playing";
  if (stateCode === 0) return currentTrack.trim().toUpperCase() === "[PAUSE]" ? "paused_playback" : "stopped";
  if (stateCode === 2 || currentTrack.trim().toUpperCase() === "[PAUSE]") return "paused_playback";
  if (currentTrack.trim().toUpperCase() === "[STOP]") return "stopped";
  return undefined;
}

/** Normalizes room labels such as `Living Room` and topic names such as `livingroom`. */
function normalizePlayerName(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
}

function currentTrackLabel(state: SonosState): string {
  if (state.playbackState === "paused_playback") return "[PAUSE]";
  if (state.playbackState === "stopped") return "[STOP]";
  const title = hmiSafeText(state.title);
  const artist = hmiSafeText(state.artist);
  const strLabel = title && artist ? `${artist} | ${title}` : title ?? artist ?? "[STOP]"
  return strLabel;
}

function playbackStateCode(state: SonosState["playbackState"]): number {
  return state === "playing" ? 1 : state === "paused_playback" ? 2 : 0;
}

function hmiSafeText(value: string): string {
  return value.replaceAll('"', "'").replaceAll("\\", " ").replace(/[\r\n\u0000-\u001f]/g, " ").trim();
}

function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
