import type { PluginConfigValue, ResolvedPluginInstance } from "../../types.js";
import type {
  MqttMessageEnvelope,
  PluginActionResult,
  PluginConfigField,
  PluginDefinition,
  PluginGroupRuntimeContext,
  PluginRuntimeContext,
  PluginScreen,
  PluginState,
  PluginSubscriptionResult
} from "./plugin-contract.js";
import { applyScriptDebugLogs, applyScriptStorageEffects, runScriptFunction } from "./script-runtime.js";
import { panelGroupSettingsTopic, isValidPanelGroupName } from "../../domain/panel-groups.js";

const DEFAULT_GROUP_SCRIPT = `const values = payload && typeof payload === "object" && !Array.isArray(payload)
  ? payload
  : { value: payload };

for (const panel of group.panels) {
  mqtt.send(panel.nodeName + "/cmnd/group/settings", {
    ...values,
    request_id: panel.requestId
  });
}`;

/** Runs a configured JavaScript transform for manager-owned group MQTT inputs. */
export class ScriptedGroupMqttPlugin implements PluginDefinition {
  readonly id = "mqtt-scripted-group";
  readonly name = "Scripted group MQTT";
  readonly version = 1;
  readonly description = "Transform a panel-group MQTT input into paced, per-panel MQTT commands with JavaScript.";
  readonly capabilities = ["mqtt", "javascript", "panel-group"];
  readonly instanceVariableFields = [
    {
      key: "groupName",
      label: "Panel group",
      required: true,
      help: "Must match the group assigned to the panels and the nspanelmanager/groups/<group>/cmnd/settings input topic."
    }
  ] as const;
  readonly configSchema: readonly PluginConfigField[] = [
    {
      key: "groupMessageCode",
      label: "Group input script",
      type: "textarea",
      required: true,
      defaultValue: DEFAULT_GROUP_SCRIPT,
      help: "Runs for the configured group's settings input. Read the incoming JSON as payload or message.payload. Use group.name and group.panels; each panel has id, name, nodeName (its active MQTT root), and requestId. Call mqtt.send(topic, payload) once per command. The manager accepts commands addressed to members of this group and sends them with a 100 ms gap."
    }
  ];

  /** Requires a group input script and keeps it within the shared script limit. */
  validateConfig(config: Record<string, PluginConfigValue>): string | undefined {
    const source = config.groupMessageCode;
    if (typeof source !== "string" || !source.trim()) return "Enter a JavaScript body for group MQTT inputs.";
    if (source.length > 32_000) return "The group input script must be under 32,000 characters.";
    return undefined;
  }

  /** Ensures this instance points at a valid manager panel group. */
  validateInstance(instance: ResolvedPluginInstance): string | undefined {
    return isValidPanelGroupName(String(instance.variables.groupName ?? ""))
      ? undefined
      : "Enter a panel group name containing 1–40 letters, numbers, underscores, or hyphens.";
  }

  /** This plugin receives manager group inputs and has no direct broker filters. */
  subscriptions(_instance: ResolvedPluginInstance): readonly string[] {
    return [];
  }

  /** Returns the manager-owned group settings topic for this instance. */
  groupMessageTopic(instance: ResolvedPluginInstance): string | undefined {
    const groupName = String(instance.variables.groupName ?? "");
    return isValidPanelGroupName(groupName) ? panelGroupSettingsTopic(groupName) : undefined;
  }

  /** Executes the configured transform with group metadata and queues its MQTT commands. */
  async handleGroupMessage(
    instance: ResolvedPluginInstance,
    message: MqttMessageEnvelope,
    state: PluginState,
    context: PluginRuntimeContext
  ): Promise<PluginSubscriptionResult | void> {
    const group: PluginGroupRuntimeContext | undefined = context.group;
    // Run only when the runtime's resolved group context matches the configured input group.
    if (!group || group.name !== instance.variables.groupName) return undefined;

    const source = typeof instance.config.groupMessageCode === "string" ? instance.config.groupMessageCode : "";
    const execution = await runScriptFunction(source, message, state, context, {
      publish: true,
      writeStorage: true
    });
    applyScriptDebugLogs(execution.effects, context);
    await applyScriptStorageEffects(execution.effects, context);
    return { commands: execution.effects.commands };
  }

  /** This service plugin does not render an interactive panel screen. */
  renderScreen(
    _instance: ResolvedPluginInstance,
    _state: PluginState,
    _screen: string,
    _context: PluginRuntimeContext
  ): PluginScreen | undefined {
    return undefined;
  }

  /** Group scripts are triggered only by manager group input topics. */
  handleAction(
    _instance: ResolvedPluginInstance,
    state: PluginState,
    _action: string,
    _context: PluginRuntimeContext
  ): PluginActionResult {
    return { screen: "exit", statePatch: state };
  }

  /** This plugin does not parse ordinary panel or external MQTT messages. */
  decodeMessage(_instance: ResolvedPluginInstance, _message: MqttMessageEnvelope): PluginState | undefined {
    return undefined;
  }
}
