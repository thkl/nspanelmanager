import { getQuickJS, shouldInterruptAfterDeadline } from "quickjs-emscripten";
import type { MqttMessageEnvelope, PanelStorageSnapshot, PluginCommand, PluginMqttSubscription, PluginPageNavigation, PluginRuntimeContext, PluginState, PluginStorageScope } from "./plugin-contract.js";
import { interpolatePluginScript } from "./plugin-variables.js";

/** One storage write or deletion queued until the script has completed. */
export interface ScriptStorageEffect {
  operation: "set" | "delete";
  scope: PluginStorageScope;
  key: string;
  value?: unknown;
  panelNameOrId?: string;
}

/** Commands, storage writes, subscriptions, logs, and navigation emitted by one script. */
export interface ScriptFunctionEffects {
  commands: PluginCommand[];
  storage: ScriptStorageEffect[];
  subscriptions: PluginMqttSubscription[];
  navigation?: PluginPageNavigation;
  logs: string[];
}

/** Value and manager-owned effects returned after a script finishes. */
export interface ScriptFunctionResult {
  value: unknown;
  effects: ScriptFunctionEffects;
}

/** Script capabilities enabled for one execution, including initialization. */
export interface ScriptFunctionOptions {
  publish: boolean;
  writeStorage: boolean;
  subscribe?: boolean;
  /** Allows panel navigation from button functions and MQTT subscription callbacks. */
  navigate?: boolean;
  /** When set, execute this callback with the current payload and message. */
  callbackSource?: string;
  /** Named helpers available to the script through `fnct.name(...args)`. */
  namedFunctions?: Array<{ id: string; parameters: string[]; code: string }>;
}

const SCRIPT_TIME_LIMIT_MS = 100;
const SCRIPT_MEMORY_LIMIT_BYTES = 8 * 1024 * 1024;
const SCRIPT_STACK_LIMIT_BYTES = 512 * 1024;
const MAX_SCRIPT_SOURCE_LENGTH = 32_000;

let quickJsPromise: ReturnType<typeof getQuickJS> | undefined;

type ScriptMessageEnvelope = Omit<MqttMessageEnvelope, "payload"> & { payload: unknown };

/**
 * Parses a configured function body inside QuickJS without invoking it.
 * Returns a concise validation error when the source is too large or invalid.
 */
export async function checkScriptSyntax(source: string, variables: PluginRuntimeContext["variables"] = {}): Promise<string | undefined> {
  if (source.length > MAX_SCRIPT_SOURCE_LENGTH) return `Script source exceeds ${MAX_SCRIPT_SOURCE_LENGTH} characters.`;

  try {
    quickJsPromise ??= getQuickJS();
    const quickJs = await quickJsPromise;
    const resolvedSource = interpolatePluginScript(source, variables);
    if (resolvedSource.length > MAX_SCRIPT_SOURCE_LENGTH) return `Script source exceeds ${MAX_SCRIPT_SOURCE_LENGTH} characters after variable substitution.`;
    const functionBody = `with (scope) {\n${resolvedSource}\n}`;
    quickJs.evalCode(`(() => { new Function("scope", ${JSON.stringify(functionBody)}); return true; })()`, {
      shouldInterrupt: shouldInterruptAfterDeadline(Date.now() + SCRIPT_TIME_LIMIT_MS),
      memoryLimitBytes: SCRIPT_MEMORY_LIMIT_BYTES,
      maxStackSizeBytes: SCRIPT_STACK_LIMIT_BYTES
    });
    return undefined;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(JSON.stringify(error));
    return detail.replace(/^SyntaxError:\s*/, "");
  }
}

/**
 * Executes one configured synchronous function inside a fresh QuickJS context.
 * Scripts receive plain message/state data and queue MQTT/storage effects; the
 * manager validates and applies those effects after execution returns.
 */
export async function runScriptFunction(
  source: string,
  message: MqttMessageEnvelope | undefined,
  state: PluginState,
  context: PluginRuntimeContext,
  options: ScriptFunctionOptions
): Promise<ScriptFunctionResult> {
  if (source.length > MAX_SCRIPT_SOURCE_LENGTH) throw new Error(`Script source exceeds ${MAX_SCRIPT_SOURCE_LENGTH} characters.`);

  const [global, plugin, panel, panels] = await Promise.all([
    context.storage.snapshot("global"),
    context.storage.snapshot("plugin"),
    context.storage.snapshot("panel"),
    context.storage.snapshotPanels()
  ]);
  const storageValues = { global, plugin, panel };
  const input = {
    message: message ? { ...message, payload: parseMqttPayload(message.payload) } : null,
    state,
    panel: context.panel,
    binding: context.binding,
    group: context.group ?? null,
    variables: context.variables,
    namedFunctions: (options.namedFunctions ?? []).map((fn) => ({
      ...fn,
      code: interpolatePluginScript(fn.code, context.variables)
    })),
    storageValues,
    panels,
    permissions: { publish: options.publish, writeStorage: options.writeStorage, subscribe: options.subscribe ?? false, navigate: options.navigate ?? false }
  };
  const code = createInvocation(
    interpolatePluginScript(source, context.variables),
    input,
    options.callbackSource ? interpolatePluginScript(options.callbackSource, context.variables) : undefined
  );
  if (code.length > MAX_SCRIPT_SOURCE_LENGTH * 4) throw new Error("Configured JavaScript exceeds the execution size limit after variable substitution.");

  try {
    quickJsPromise ??= getQuickJS();
    const quickJs = await quickJsPromise;
    const value: unknown = quickJs.evalCode(code, {
      shouldInterrupt: shouldInterruptAfterDeadline(Date.now() + SCRIPT_TIME_LIMIT_MS),
      memoryLimitBytes: SCRIPT_MEMORY_LIMIT_BYTES,
      maxStackSizeBytes: SCRIPT_STACK_LIMIT_BYTES
    });
    if (!isRecord(value) || !isRecord(value.effects)) throw new Error("Script returned an invalid result.");
    return {
      value: value.value,
      effects: {
        commands: Array.isArray(value.effects.commands) ? value.effects.commands.filter(isPluginCommand) : [],
        storage: Array.isArray(value.effects.storage) ? value.effects.storage.filter(isStorageEffect) : [],
        subscriptions: Array.isArray(value.effects.subscriptions) ? value.effects.subscriptions.filter(isPluginMqttSubscription) : [],
        navigation: isPluginPageNavigation(value.effects.navigation) ? value.effects.navigation : undefined,
        logs: Array.isArray(value.effects.logs) ? value.effects.logs.filter((entry): entry is string => typeof entry === "string").slice(0, 100) : []
      }
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(JSON.stringify(error));
    throw new Error(`Configured JavaScript failed: ${detail}`);
  }
}

/** Applies script-requested persistence through the manager's scoped store API. */
export async function applyScriptStorageEffects(effects: ScriptFunctionEffects, context: PluginRuntimeContext): Promise<void> {
  for (const effect of effects.storage) {
    if (effect.scope === "panel" && effect.panelNameOrId) {
      if (effect.operation === "set") await context.storage.setPanel(effect.panelNameOrId, effect.key, effect.value);
      else await context.storage.deletePanel(effect.panelNameOrId, effect.key);
    } else if (effect.operation === "set") {
      await context.storage.set(effect.scope, effect.key, effect.value);
    } else {
      await context.storage.delete(effect.scope, effect.key);
    }
  }
}

/** Sends buffered script diagnostics to the active manager or preview logger. */
export function applyScriptDebugLogs(effects: ScriptFunctionEffects, context: PluginRuntimeContext): void {
  for (const line of effects.logs) context.debug.log(line);
}

function createInvocation(source: string, input: {
  message: ScriptMessageEnvelope | null;
  state: PluginState;
  panel: PluginRuntimeContext["panel"];
  binding: PluginRuntimeContext["binding"];
  group: PluginRuntimeContext["group"] | null;
  storageValues: Record<PluginStorageScope, Record<string, unknown>>;
  panels: PanelStorageSnapshot[];
  namedFunctions: Array<{ id: string; parameters: string[]; code: string }>;
  variables: PluginRuntimeContext["variables"];
  permissions: { publish: boolean; writeStorage: boolean; subscribe: boolean; navigate: boolean };
}, callbackSource?: string): string {
  const scriptBody = callbackSource
    ? `const subscriptionHandler = (${callbackSource}); return subscriptionHandler(payload, message);`
    : source;
  const invocationBody = "with (scope) {\n" + scriptBody + "\n}";
  return `(() => {
    const input = ${JSON.stringify(input)};
    const effects = { commands: [], storage: [], subscriptions: [], navigation: undefined, logs: [] };
    const hasOwn = (target, key) => Object.prototype.hasOwnProperty.call(target, key);
    const writeOwn = (target, key, value) => Object.defineProperty(target, key, {
      value, writable: true, enumerable: true, configurable: true
    });
    const cloneJsonValue = (value) => {
      const serialized = JSON.stringify(value);
      if (serialized === undefined) throw new Error("Storage value must be JSON serializable.");
      return JSON.parse(serialized);
    };
    const requireWritableStorage = () => {
      if (!input.permissions.writeStorage) throw new Error("Storage writes are only available to button functions.");
    };
    const requireStorageKey = (key) => {
      if (typeof key !== "string" || !key.trim()) throw new Error("Storage key is required.");
    };
    const requestPageNavigation = (type, name) => {
      if (!input.permissions.navigate) throw new Error("Page navigation is only available to button functions and MQTT subscription callbacks.");
      if (name !== undefined && (typeof name !== "string" || !name.trim())) throw new Error("Page ID must be a non-empty string.");
      const screen = typeof name === "string" ? name.trim() : undefined;
      if (type === "go" && !screen) throw new Error("gotopage requires a page ID.");
      effects.navigation = { type, ...(screen ? { screen } : {}) };
      return true;
    };
    const gotopage = (name) => requestPageNavigation("go", name);
    const reloadpage = (name) => requestPageNavigation("reload", name);
    /** Compares JSON-like values recursively while ignoring object key order. */
    const isEqual = (obj1, obj2) => {
      if (obj1 === obj2) return true;
      if (typeof obj1 !== "object" || obj1 === null || typeof obj2 !== "object" || obj2 === null) return false;
      const keys1 = Object.keys(obj1).sort();
      const keys2 = Object.keys(obj2).sort();
      if (keys1.length !== keys2.length) return false;
      for (let index = 0; index < keys1.length; index++) {
        const key = keys1[index];
        if (key !== keys2[index] || !isEqual(obj1[key], obj2[key])) return false;
      }
      return true;
    };
    const globalStore = {
      get(key, defaultValue) {
        requireStorageKey(key);
        const value = hasOwn(input.storageValues.global, key) ? input.storageValues.global[key] : undefined;
        return value === undefined ? defaultValue : value;
      },
      set(key, value) {
        requireWritableStorage();
        requireStorageKey(key);
        const storedValue = cloneJsonValue(value);
        effects.storage.push({ operation: "set", scope: "global", key, value: storedValue });
        writeOwn(input.storageValues.global, key, storedValue);
      },
      delete(key) {
        requireWritableStorage();
        requireStorageKey(key);
        effects.storage.push({ operation: "delete", scope: "global", key });
        delete input.storageValues.global[key];
      }
    };
    const pluginStore = {
      get(key, defaultValue) {
        requireStorageKey(key);
        const value = hasOwn(input.storageValues.plugin, key) ? input.storageValues.plugin[key] : undefined;
        return value === undefined ? defaultValue : value;
      },
      set(key, value) {
        requireWritableStorage();
        requireStorageKey(key);
        const storedValue = cloneJsonValue(value);
        effects.storage.push({ operation: "set", scope: "plugin", key, value: storedValue });
        writeOwn(input.storageValues.plugin, key, storedValue);
      },
      delete(key) {
        requireWritableStorage();
        requireStorageKey(key);
        effects.storage.push({ operation: "delete", scope: "plugin", key });
        delete input.storageValues.plugin[key];
      }
    };
    const findPanelStore = (panelNameOrId) => {
      if (typeof panelNameOrId !== "string" || !panelNameOrId.trim()) throw new Error("Panel name or ID is required.");
      const matches = input.panels.filter((candidate) => candidate.name === panelNameOrId || candidate.id === panelNameOrId);
      if (matches.length > 1) throw new Error("Panel name is ambiguous; use its panel ID.");
      return matches[0];
    };
    const panelStore = {
      get(panelNameOrId, key, defaultValue) {
        requireStorageKey(key);
        const target = findPanelStore(panelNameOrId);
        const value = target && hasOwn(target.values, key) ? target.values[key] : undefined;
        return value === undefined ? defaultValue : value;
      },
      set(panelNameOrId, key, value) {
        requireWritableStorage();
        requireStorageKey(key);
        const target = findPanelStore(panelNameOrId);
        if (!target) throw new Error("Panel was not found.");
        const storedValue = cloneJsonValue(value);
        effects.storage.push({ operation: "set", scope: "panel", panelNameOrId: target.id, key, value: storedValue });
        writeOwn(target.values, key, storedValue);
      },
      delete(panelNameOrId, key) {
        requireWritableStorage();
        requireStorageKey(key);
        const target = findPanelStore(panelNameOrId);
        if (!target) throw new Error("Panel was not found.");
        effects.storage.push({ operation: "delete", scope: "panel", panelNameOrId: target.id, key });
        delete target.values[key];
      }
    };
    const mqtt = {
      send(topic, payload) {
        if (!input.permissions.publish) throw new Error("MQTT publishing is only available to button functions.");
        if (typeof topic !== "string" || !topic.trim() || /[+#\\u0000]/.test(topic)) throw new Error("Publish topic must be a concrete MQTT topic.");
        const serializedPayload = typeof payload === "string" ? payload : JSON.stringify(payload);
        if (serializedPayload === undefined) throw new Error("MQTT payload must be a string or JSON value.");
        effects.commands.push({ topic, payload: serializedPayload });
        return true;
      },
      subscribe(topicFilter, handler) {
        if (!input.permissions.subscribe) throw new Error("MQTT subscriptions are only available to the plugin startup function.");
        if (typeof topicFilter !== "string" || !isValidTopicFilter(topicFilter)) throw new Error("Subscription topic must be a valid MQTT topic filter.");
        if (typeof handler !== "function") throw new Error("MQTT subscription handler must be a function.");
        const handlerSource = Function.prototype.toString.call(handler);
        if (handlerSource.length > ${MAX_SCRIPT_SOURCE_LENGTH}) throw new Error("MQTT subscription handler is too large.");
        effects.subscriptions.push({ topicFilter, handlerSource });
        return true;
      }
    };
    const debug = {
      log(...values) {
        if (effects.logs.length >= 100) return;
        const line = values.map((value) => {
          if (typeof value === "string") return value;
          try {
            const serialized = JSON.stringify(value);
            return serialized === undefined ? String(value) : serialized;
          } catch {
            return String(value);
          }
        }).join(" ");
        effects.logs.push(line.slice(0, 2000));
      }
    };
    const isValidTopicFilter = (filter) => {
      if (!filter || filter.includes("\\u0000")) return false;
      const levels = filter.split("/");
      return levels.every((level, index) => {
        if (level.includes("#")) return level === "#" && index === levels.length - 1;
        return !level.includes("+") || level === "+";
      });
    };
    const context = {
      panel: input.panel,
      binding: input.binding,
      group: input.group,
      publish(topic, payload) {
        if (!input.permissions.publish) throw new Error("MQTT publishing is only available to button functions.");
        if (typeof topic !== "string" || !topic.trim() || /[+#\\u0000]/.test(topic)) throw new Error("Publish topic must be a concrete MQTT topic.");
        if (typeof payload !== "string") throw new Error("Publish payload must be a string.");
        effects.commands.push({ topic, payload });
        return true;
      },
      storage: {
        get(scope, key) {
          if (!Object.prototype.hasOwnProperty.call(input.storageValues, scope)) throw new Error("Unknown storage scope.");
          if (typeof key !== "string") throw new Error("Storage key must be a string.");
          return Object.prototype.hasOwnProperty.call(input.storageValues[scope], key) ? input.storageValues[scope][key] : undefined;
        },
        set(scope, key, value) {
          if (!input.permissions.writeStorage) throw new Error("Storage writes are only available to button functions.");
          if (!Object.prototype.hasOwnProperty.call(input.storageValues, scope)) throw new Error("Unknown storage scope.");
          if (typeof key !== "string" || !key.trim()) throw new Error("Storage key is required.");
          const serialized = JSON.stringify(value);
          if (serialized === undefined) throw new Error("Storage value must be JSON serializable.");
          const storedValue = JSON.parse(serialized);
          effects.storage.push({ operation: "set", scope, key, value: storedValue });
          writeOwn(input.storageValues[scope], key, storedValue);
        },
        delete(scope, key) {
          if (!input.permissions.writeStorage) throw new Error("Storage writes are only available to button functions.");
          if (!Object.prototype.hasOwnProperty.call(input.storageValues, scope)) throw new Error("Unknown storage scope.");
          if (typeof key !== "string" || !key.trim()) throw new Error("Storage key is required.");
          effects.storage.push({ operation: "delete", scope, key });
          delete input.storageValues[scope][key];
        }
      }
    };
    const payload = input.message ? input.message.payload : "";
    const variables = input.variables;
    const group = input.group;
    const fnct = Object.create(null);
    const scope = {
      message: input.message,
      payload,
      state: input.state,
      context,
      group,
      debug,
      mqtt,
      global: globalStore,
      plugin: pluginStore,
      panel: panelStore,
      variables,
      gotopage,
      reloadpage,
      isEqual,
      fnct
    };
    for (const definition of input.namedFunctions) {
      // A helper with no configured parameter names receives its first
      // argument under the standard message name, matching render scripts.
      const parameterNames = definition.parameters.length ? definition.parameters : ["message"];
      const parameterDeclaration = definition.parameters.length
        ? "const [" + parameterNames.join(",") + "] = args;\\n"
        : "const [message] = args;\\n";
      const functionBody = "with (scope) {\\n" + parameterDeclaration + definition.code + "\\n}";
      const invoke = new Function("scope", "args", functionBody);
      Object.defineProperty(fnct, definition.id, {
        value: (...args) => invoke(scope, args),
        enumerable: true,
        configurable: false,
        writable: false
      });
    }
    const run = new Function("scope", ${JSON.stringify(invocationBody)});
    const value = run(scope);
    return { value: value === undefined ? null : value, effects };
  })()`;
}

function isValidTopicFilter(filter: string): boolean {
  if (!filter || filter.includes("\u0000")) return false;
  const levels = filter.split("/");
  return levels.every((level, index) => {
    if (level.includes("#")) return level === "#" && index === levels.length - 1;
    return !level.includes("+") || level === "+";
  });
}

function isPluginCommand(value: unknown): value is PluginCommand {
  return isRecord(value) && typeof value.topic === "string" && typeof value.payload === "string";
}

function isPluginMqttSubscription(value: unknown): value is PluginMqttSubscription {
  return isRecord(value) && typeof value.topicFilter === "string" && isValidTopicFilter(value.topicFilter) &&
    typeof value.handlerSource === "string" && value.handlerSource.length > 0 && value.handlerSource.length <= MAX_SCRIPT_SOURCE_LENGTH;
}

function isPluginPageNavigation(value: unknown): value is PluginPageNavigation {
  return isRecord(value) && (value.type === "go" && typeof value.screen === "string" || value.type === "reload" && (value.screen === undefined || typeof value.screen === "string"));
}

function parseMqttPayload(payload: string): unknown {
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return payload;
  }
}

function isStorageEffect(value: unknown): value is ScriptStorageEffect {
  return isRecord(value) && (value.operation === "set" || value.operation === "delete") &&
    (value.scope === "global" || value.scope === "plugin" || value.scope === "panel") &&
    typeof value.key === "string" && (value.operation === "delete" || "value" in value) &&
    (!("panelNameOrId" in value) || value.scope === "panel" && typeof value.panelNameOrId === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
