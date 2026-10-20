import type { PluginDefinition } from "./plugin-contract.js";

/**
 * Owns the set of plugin implementations available to configured instances.
 * Definitions are registered once during server startup and are read by the
 * API for schema discovery and by the MQTT runtime for lifecycle dispatch.
 */
export class PluginRegistry {
  private readonly definitions = new Map<string, PluginDefinition>();
  private readonly aliases = new Map<string, string>();

  /** Registers a plugin definition and rejects duplicate identifiers at startup. */
  register(definition: PluginDefinition): void {
    if (this.definitions.has(definition.id) || this.aliases.has(definition.id)) throw new Error(`Plugin '${definition.id}' is already registered.`);
    this.definitions.set(definition.id, definition);
  }

  /** Maps an old saved plugin ID to its replacement without exposing a duplicate editor option. */
  registerAlias(alias: string, pluginId: string): void {
    if (this.definitions.has(alias) || this.aliases.has(alias)) throw new Error(`Plugin alias '${alias}' is already registered.`);
    if (!this.definitions.has(pluginId)) throw new Error(`Plugin '${pluginId}' must be registered before alias '${alias}'.`);
    this.aliases.set(alias, pluginId);
  }

  /** Returns an implementation by its stable configuration identifier. */
  get(pluginId: string): PluginDefinition | undefined { return this.definitions.get(this.canonicalId(pluginId)); }

  /** Resolves an old saved identifier to the identifier exposed by the API. */
  canonicalId(pluginId: string): string { return this.aliases.get(pluginId) ?? pluginId; }

  /** Returns public plugin metadata and schemas without runtime implementation functions. */
  list(): Array<Pick<PluginDefinition, "id" | "name" | "version" | "description" | "capabilities" | "configSchema" | "nativePanelPage" | "nativePanelSharedInstances" | "instanceVariableFields" | "homeTileType" | "favoriteFlow" | "favoritePanelPage"> & { aliases: string[] }> {
    return [...this.definitions.values()].map(({ id, name, version, description, capabilities, configSchema, nativePanelPage, nativePanelSharedInstances, instanceVariableFields, homeTileType, favoriteFlow, favoritePanelPage }) => ({
      id, name, version, description, capabilities, configSchema,
      aliases: [...this.aliases.keys()].filter((alias) => this.canonicalId(alias) === id),
      ...(favoriteFlow ? { favoriteFlow } : {}),
      ...(favoritePanelPage ? { favoritePanelPage } : {}),
      ...(nativePanelPage ? { nativePanelPage } : {}),
      ...(nativePanelSharedInstances ? { nativePanelSharedInstances } : {}),
      ...(instanceVariableFields ? { instanceVariableFields } : {}),
      ...(homeTileType ? { homeTileType } : {})
    }));
  }
}
