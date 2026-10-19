import type { PluginConfigValue, ResolvedPluginInstance } from "../../types.js";
import type { MqttMessageEnvelope, PluginActionResult, PluginConfigField, PluginDefinition, PluginMqttSubscription, PluginPageNavigation, PluginRuntimeContext, PluginScreen, PluginState, PluginSubscriptionResult } from "./plugin-contract.js";
import { applyScriptDebugLogs, applyScriptStorageEffects, runScriptFunction } from "./script-runtime.js";
import { interpolatePluginTemplate } from "./plugin-variables.js";

const DEFAULT_RENDER_CODE = `const rawPayload = message ? message.payload : "";
const displayPayload = typeof rawPayload === "string" ? rawPayload : JSON.stringify(rawPayload);
return {
  title: "MQTT Device",
  message: displayPayload || "Waiting for a matching MQTT message",
  buttons: ["", "", "", "", "", "", "", ""]
};`;

interface ScriptPage {
  id: string;
  name: string;
  renderCode: string;
}

interface ScriptFunction {
  id: string;
  parameters: string[];
  code: string;
}

interface StoredScriptFunction {
  id: string;
  parameters: string;
  code: string;
}

interface ScriptButtonAction {
  pageId: string;
  slot: string;
  type: string;
  target: string;
  topic: string;
  payload: string;
}

/**
 * Provides the configurable MQTT-to-NSPanel runtime. Reusable plugin profiles
 * own topic filters, page renderers, named functions, and page actions. Each
 * instance supplies its own variables and runtime state to this shared logic.
 */
export class ScriptedMqttPlugin implements PluginDefinition {
  /** Stable public identifier used for new instances and API discovery. */
  readonly id = "mqtt-scripted";
  readonly name = "Scripted MQTT plugin";
  readonly version = 8;
  readonly description = "Turn MQTT messages into configurable panel pages, button actions, and startup subscriptions using JavaScript.";
  readonly capabilities = ["mqtt", "panel-pages", "javascript"];
  readonly configSchema: readonly PluginConfigField[] = [
    {
      key: "topicFilters",
      label: "Incoming MQTT topic filters (optional)",
      type: "textarea",
      defaultValue: "",
      help: "Optional. Enter one filter per line to render pages from matching device messages. Leave blank when startupCode subscriptions provide the incoming data. MQTT + and # wildcards are supported."
    },
    {
      key: "startupCode",
      label: "Plugin startup function",
      type: "textarea",
      defaultValue: "",
      help: "Runs when this enabled plugin instance starts and when its settings are saved. Register handlers with mqtt.subscribe(\"topic/filter\", (payload, message) => { ... }). The callback receives parsed JSON in payload and message.payload. The latest normalized message stays in memory and resets on restart. Use plugin.set(key, value) to persist state for this plugin instance, global.set(key, value) for shared state, or panel.set(panelName, key, value) for one panel. These set calls update the in-memory cache immediately; durable snapshots are coalesced to at most once per second. Forced termination may lose changes since the last snapshot. Storage is capped at 64 KiB per value and 2 MiB total. Use {{room}} inside strings or variables.room in JavaScript to read this instance's variables. Call defined helpers as fnct.functionId(arg1, arg2); parameter names are configured on each helper. Use isEqual(value1, value2) to recursively compare JSON objects and arrays regardless of object key order. In callbacks, gotopage(\"pageId\") opens a page and adds Back history on active panels bound to this instance; reloadpage() redraws their current page, while reloadpage(\"pageId\") shows and redraws that page without adding Back history. debug.log(...) writes to the API manager logs."
    },
    { key: "startPage", label: "Start page ID", type: "text", required: true, defaultValue: "overview", help: "Page opened by the panel favorite." },
    {
      key: "pages",
      label: "Pages and render functions",
      type: "table",
      defaultValue: JSON.stringify([{ id: "overview", name: "Overview", renderCode: DEFAULT_RENDER_CODE }]),
      help: "The JavaScript body receives message, payload, state, context, debug, mqtt, global, plugin, panel, variables, and fnct. Call defined helpers as fnct.functionId(arg1, arg2); parameter names are configured on each helper. Use {{room}} inside strings or variables.room in JavaScript to read this instance's configured variables. JSON MQTT payloads are parsed in message.payload and payload; non-JSON payloads stay text. Read the topic as message.topic, read saved values with global.get(key, defaultValue), plugin.get(key, defaultValue), or panel.get(panelName, key, defaultValue), compare nested JSON values with isEqual(value1, value2), and use debug.log(...) for preview and manager log output. Return { title, message, buttons } to update the display, or return nothing to leave it unchanged. Renderers are read-only.",
      columns: [
        { key: "id", label: "Page ID" },
        { key: "name", label: "Page name" },
        { key: "renderCode", label: "Render function body", multiline: true }
      ],
      minRows: 1,
      maxRows: 16,
      rowHeader: "Page",
      addRowLabel: "Add page"
    },
    {
      key: "functions",
      label: "Named JavaScript functions",
      type: "table",
      defaultValue: "[]",
      help: "Named functions can be called from any plugin script as fnct.functionId(arg1, arg2). With no Parameters configured, the first argument is available in the function body as message; for example, call fnct.formatStatus(message) and read message.payload. You can optionally enter comma-separated parameter names, such as message, label, in the Parameters column. The function body can return a value or use the caller's available helpers. Button actions pass the current message as the first argument. Scripts receive message, payload, state, context, debug, mqtt, global, plugin, panel, and variables. Use {{room}} inside strings or variables.room in JavaScript to read this instance's configured variables. JSON MQTT payloads are parsed in message.payload and payload; non-JSON payloads stay text. Use isEqual(value1, value2) to recursively compare nested JSON objects and arrays independent of object key order. Use gotopage(\"pageId\") to open a page and add Back history, reloadpage() to redraw the current page, or reloadpage(\"pageId\") to show and redraw a named page without adding Back history. Use mqtt.send(topic, payload), where payload may be a string or JSON value; use global.get(key, defaultValue), global.set(key, value), plugin.get(key, defaultValue), plugin.set(key, value), panel.get(panelName, key, defaultValue), and panel.set(panelName, key, value) for durable values. debug.log(...) adds diagnostics to preview or manager logs. context.publish and context.storage remain available.",
      columns: [
        { key: "id", label: "Function ID" },
        { key: "parameters", label: "Parameters" },
        { key: "code", label: "Function body", multiline: true }
      ],
      minRows: 0,
      maxRows: 32,
      rowHeader: "Function",
      addRowLabel: "Add function"
    },
    {
      key: "buttonActions",
      label: "Button actions",
      type: "table",
      defaultValue: "[]",
      help: "Configure button actions inside each page tab. Each page has eight button slots. Choose a target page or function, or enter an MQTT topic and payload. Use {{variableName}} in MQTT action topics and payloads to insert an instance variable.",
      columns: [
        { key: "pageId", label: "Page ID" },
        { key: "slot", label: "Button", options: Array.from({ length: 8 }, (_, index) => String(index + 1)) },
        { key: "type", label: "Action type", options: ["none", "page", "mqtt", "function"] },
        { key: "target", label: "Page or function ID" },
        { key: "topic", label: "MQTT topic" },
        { key: "payload", label: "MQTT payload", multiline: true }
      ],
      minRows: 0,
      maxRows: 128,
      rowHeader: "Action",
      addRowLabel: "Add button action"
    }
  ];

  /** Validates subscriptions, page IDs, function IDs, and button action targets. */
  validateConfig(config: Record<string, PluginConfigValue>): string | undefined {
    const filters = readTopicFilters(config.topicFilters);
    if (filters.some((filter) => !isValidTopicFilter(filter))) return "Enter valid MQTT topic filters or leave the field blank.";

    const pages = parseRows<ScriptPage>(config.pages, ["id", "name", "renderCode"]);
    if (!pages || pages.length < 1 || pages.length > 16) return "Configure between 1 and 16 valid pages.";
    const pageIds = new Set<string>();
    for (const page of pages) {
      if (!isSafeId(page.id) || pageIds.has(page.id)) return "Page IDs must be unique letters, numbers, dashes, or underscores.";
      if (!page.name.trim() || !page.renderCode.trim() || page.renderCode.length > 32_000) return `Page ${page.id} needs a name and a render function body under 32,000 characters.`;
      pageIds.add(page.id);
    }
    if (!pageIds.has(String(config.startPage ?? ""))) return "Start page ID must match one of the configured pages.";

    const functions = parseScriptFunctions(config.functions);
    if (!functions || functions.length > 32) return "Named functions must be a valid table with at most 32 rows.";
    const functionIds = new Set<string>();
    let functionSourceLength = 0;
    for (const fn of functions) {
      if (!isSafeId(fn.id) || functionIds.has(fn.id)) return "Function IDs must be unique letters, numbers, dashes, or underscores.";
      if (!fn.code.trim() || fn.code.length > 32_000) return `Function ${fn.id} needs a function body under 32,000 characters.`;
      if (!parseFunctionParameters(fn.parameters)) return `Function ${fn.id} has invalid parameters. Enter unique JavaScript names separated by commas.`;
      functionSourceLength += fn.code.length;
      functionIds.add(fn.id);
    }
    if (functionSourceLength > 32_000) return "Keep the combined named function bodies under 32,000 characters.";

    const actions = parseRows<ScriptButtonAction>(config.buttonActions, ["pageId", "slot", "type", "target", "topic", "payload"]);
    if (!actions || actions.length > 128) return "Button actions must be a valid table with at most 128 rows.";
    const actionSlots = new Set<string>();
    for (const action of actions) {
      const slot = Number(action.slot);
      if (!pageIds.has(action.pageId) || !Number.isInteger(slot) || slot < 1 || slot > 8) return "Each button action needs a valid page ID and a button number from 1 to 8.";
      const uniqueSlot = `${action.pageId}:${slot}`;
      if (actionSlots.has(uniqueSlot)) return `Page ${action.pageId} has more than one action for button ${slot}.`;
      actionSlots.add(uniqueSlot);
      if (action.type === "none") continue;
      if (action.type === "page" && !pageIds.has(action.target)) return `Button ${slot} on ${action.pageId} must target a configured page.`;
      if (action.type === "function" && !functionIds.has(action.target)) return `Button ${slot} on ${action.pageId} must target a configured function.`;
      if (action.type === "mqtt" && !isPublishableTopic(action.topic)) return `Button ${slot} on ${action.pageId} needs a valid MQTT publish topic.`;
      if (!["page", "function", "mqtt"].includes(action.type)) return `Button ${slot} on ${action.pageId} has an unknown action type.`;
    }
    return undefined;
  }

  /** Returns all configured filters, with legacy topic support for upgrades. */
  subscriptions(instance: ResolvedPluginInstance): readonly string[] {
    const configured = readTopicFilters(instance.config.topicFilters);
    if (configured.length) return configured.map((filter) => interpolatePluginTemplate(filter, instance.variables));
    const legacyTopic = instance.config.stateTopic;
    return typeof legacyTopic === "string" && legacyTopic.trim()
      ? [interpolatePluginTemplate(legacyTopic.trim(), instance.variables)]
      : [];
  }

  /** Runs the instance startup script and captures its dynamic MQTT handlers. */
  async initialize(instance: ResolvedPluginInstance, state: PluginState, context: PluginRuntimeContext): Promise<readonly PluginMqttSubscription[]> {
    const source = configString(instance, "startupCode").trim();
    if (!source) return [];
    const execution = await runScriptFunction(source, undefined, state, context, { publish: false, writeStorage: true, subscribe: true, namedFunctions: getFunctions(instance) });
    applyScriptDebugLogs(execution.effects, context);
    await applyScriptStorageEffects(execution.effects, context);
    return execution.effects.subscriptions;
  }

  /** Runs one dynamic MQTT callback and returns its queued commands and navigation request. */
  async handleSubscription(
    instance: ResolvedPluginInstance,
    subscription: PluginMqttSubscription,
    message: MqttMessageEnvelope,
    state: PluginState,
    context: PluginRuntimeContext
  ): Promise<PluginSubscriptionResult> {
    const execution = await runScriptFunction("", message, state, context, {
      publish: true,
      writeStorage: true,
      navigate: true,
      namedFunctions: getFunctions(instance),
      callbackSource: subscription.handlerSource
    });
    const navigation = validatePageNavigation(instance, execution.effects.navigation);
    applyScriptDebugLogs(execution.effects, context);
    await applyScriptStorageEffects(execution.effects, context);
    return {
      commands: execution.effects.commands,
      statePatch: { lastMessage: message },
      navigation
    };
  }

  /** Keeps the complete latest MQTT envelope for page rendering and actions. */
  decodeMessage(_instance: ResolvedPluginInstance, message: MqttMessageEnvelope): PluginState | undefined {
    return { lastMessage: message };
  }

  /** Returns the configured page used when a favorite opens this instance. */
  startScreen(instance: ResolvedPluginInstance): string { return configString(instance, "startPage", "overview"); }

  /** Runs a page renderer against the latest cached MQTT message. */
  async renderScreen(instance: ResolvedPluginInstance, state: PluginState, screen: string, context: PluginRuntimeContext): Promise<PluginScreen | undefined> {
    const page = getPages(instance).find((candidate) => candidate.id === screen) ?? getPages(instance).find((candidate) => candidate.id === this.startScreen(instance));
    if (!page) throw new Error("The configured plugin has no valid page to render.");
    const execution = await runScriptFunction(page.renderCode, readMessage(state.lastMessage), state, context, {
      publish: false,
      writeStorage: false,
      namedFunctions: getFunctions(instance)
    });
    applyScriptDebugLogs(execution.effects, context);
    const result = parseScreenResult(execution.value);
    if (!result) return undefined;
    const actions = getActions(instance).filter((action) => action.pageId === page.id);
    return {
      title: result.title,
      message: result.message,
      buttons: result.buttons.map((label, index) => {
        const action = actions.find((candidate) => Number(candidate.slot) === index + 1 && candidate.type !== "none");
        return { label, action: action ? `slot:${page.id}:${index + 1}` : "" };
      })
    };
  }

  /** Dispatches one configured button slot as navigation, MQTT publish, or function. */
  async handleAction(instance: ResolvedPluginInstance, state: PluginState, actionToken: string, context: PluginRuntimeContext): Promise<PluginActionResult> {
    const match = /^slot:([a-zA-Z0-9_-]+):([1-8])$/.exec(actionToken);
    if (!match) return { screen: this.startScreen(instance) };
    const [, pageId, slot] = match;
    const configured = getActions(instance).find((candidate) => candidate.pageId === pageId && candidate.slot === slot);
    if (!configured) return { screen: pageId };
    if (configured.type === "page") return { screen: configured.target };
    if (configured.type === "mqtt") {
      const topic = interpolatePluginTemplate(configured.topic, context.variables);
      if (!isPublishableTopic(topic)) throw new Error("The MQTT action topic is invalid after variable substitution.");
      return {
        screen: pageId,
        commands: [{ topic, payload: interpolatePluginTemplate(configured.payload, context.variables) }]
      };
    }
    if (configured.type === "function") {
      const fn = getFunctions(instance).find((candidate) => candidate.id === configured.target);
      if (!fn) throw new Error(`Configured function '${configured.target}' no longer exists.`);
      const execution = await runScriptFunction(`return fnct[${JSON.stringify(fn.id)}](message);`, readMessage(state.lastMessage), state, context, {
        publish: true,
        writeStorage: true,
        navigate: true,
        namedFunctions: getFunctions(instance)
      });
      const navigation = validatePageNavigation(instance, execution.effects.navigation);
      applyScriptDebugLogs(execution.effects, context);
      await applyScriptStorageEffects(execution.effects, context);
      return { screen: navigation?.screen ?? pageId, navigation, commands: execution.effects.commands };
    }
    return { screen: pageId };
  }
}

function parseScreenResult(value: unknown): { title: string; message: string; buttons: string[] } | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value) || typeof value.title !== "string" || typeof value.message !== "string" || !Array.isArray(value.buttons)) {
    throw new Error("A page render function must return title, message, and a buttons array.");
  }
  const buttons = value.buttons.slice(0, 8).map((label: unknown) => typeof label === "string" ? label : "");
  while (buttons.length < 8) buttons.push("");
  return { title: value.title, message: value.message, buttons };
}

function getPages(instance: ResolvedPluginInstance): ScriptPage[] {
  return parseRows<ScriptPage>(instance.config.pages, ["id", "name", "renderCode"]) ?? [
    { id: "overview", name: "Overview", renderCode: DEFAULT_RENDER_CODE }
  ];
}

function getFunctions(instance: ResolvedPluginInstance): ScriptFunction[] {
  return (parseScriptFunctions(instance.config.functions) ?? []).flatMap((fn) => {
    const parameters = parseFunctionParameters(fn.parameters);
    return parameters ? [{ ...fn, parameters }] : [];
  });
}

function parseScriptFunctions(value: unknown): StoredScriptFunction[] | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return undefined;
    const functions: StoredScriptFunction[] = [];
    for (const item of parsed) {
      if (!isRecord(item) || typeof item.id !== "string" || typeof item.code !== "string" ||
        item.parameters !== undefined && typeof item.parameters !== "string") return undefined;
      functions.push({ id: item.id, code: item.code, parameters: typeof item.parameters === "string" ? item.parameters : "" });
    }
    return functions;
  } catch {
    return undefined;
  }
}

const RESERVED_FUNCTION_PARAMETERS = new Set([
  "arguments", "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete",
  "do", "else", "enum", "eval", "export", "extends", "false", "finally", "for", "function", "if", "implements",
  "import", "in", "instanceof", "interface", "let", "new", "null", "package", "private", "protected", "public",
  "return", "static", "super", "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while",
  "with", "yield"
]);

function parseFunctionParameters(value: string): string[] | undefined {
  if (!value.trim()) return [];
  const parameters = value.split(",").map((parameter) => parameter.trim());
  if (parameters.length > 16 || parameters.some((parameter) => !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(parameter) || RESERVED_FUNCTION_PARAMETERS.has(parameter))) return undefined;
  return new Set(parameters).size === parameters.length ? parameters : undefined;
}

function getActions(instance: ResolvedPluginInstance): ScriptButtonAction[] {
  return parseRows<ScriptButtonAction>(instance.config.buttonActions, ["pageId", "slot", "type", "target", "topic", "payload"]) ?? [];
}

function validatePageNavigation(instance: ResolvedPluginInstance, navigation: PluginPageNavigation | undefined): PluginPageNavigation | undefined {
  if (!navigation) return undefined;
  if (navigation.type === "go" && !navigation.screen) throw new Error("gotopage requires a page ID.");
  if (navigation.screen && !getPages(instance).some((page) => page.id === navigation.screen)) {
    throw new Error(`Page '${navigation.screen}' is not configured.`);
  }
  return navigation;
}

function parseRows<T extends object>(value: unknown, requiredFields: string[]): T[] | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return undefined;
    const rows: T[] = [];
    for (const item of parsed) {
      if (!isRecord(item) || requiredFields.some((field) => typeof item[field] !== "string")) return undefined;
      rows.push(Object.fromEntries(requiredFields.map((field) => [field, item[field] as string])) as T);
    }
    return rows;
  } catch {
    return undefined;
  }
}

function readTopicFilters(value: unknown): string[] {
  return typeof value === "string" ? value.split(/\r?\n/).map((filter) => filter.trim()).filter(Boolean) : [];
}

function readMessage(value: unknown): MqttMessageEnvelope | undefined {
  if (!isRecord(value) || typeof value.topic !== "string" || typeof value.payload !== "string") return undefined;
  if (typeof value.receivedAt !== "number" || typeof value.retain !== "boolean" || ![0, 1, 2].includes(value.qos as number)) return undefined;
  return value as unknown as MqttMessageEnvelope;
}

function isValidTopicFilter(filter: string): boolean {
  if (!filter || filter.includes("\u0000")) return false;
  const levels = filter.split("/");
  return levels.every((level, index) => {
    if (level.includes("#")) return level === "#" && index === levels.length - 1;
    return !level.includes("+") || level === "+";
  });
}

function isPublishableTopic(topic: string): boolean { return Boolean(topic.trim()) && !/[+#\u0000]/.test(topic); }
function isSafeId(value: string): boolean { return /^[a-zA-Z0-9_-]+$/.test(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function configString(instance: ResolvedPluginInstance, key: string, fallback = ""): string {
  const value = instance.config[key];
  return typeof value === "string" ? value : fallback;
}
