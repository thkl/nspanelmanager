import type { PluginConfigValue, PluginProfile } from "../../types.js";
import type { PluginDefinition } from "./plugin-contract.js";
import type { PluginRegistry } from "./plugin-registry.js";

/** Returns a profile suitable for a browser response with secret values removed. */
export function presentPluginProfile(profile: PluginProfile, registry: PluginRegistry): PluginProfile {
  const definition = registry.get(profile.pluginId);
  const config = { ...profile.config };
  const configuredSecrets: string[] = [];
  for (const field of definition?.configSchema ?? []) {
    if (!field.secret) continue;
    if (typeof config[field.key] === "string" && config[field.key]) configuredSecrets.push(field.key);
    config[field.key] = "";
  }
  return {
    ...profile,
    pluginId: registry.canonicalId(profile.pluginId),
    config,
    configuredSecrets
  };
}

/** Retains saved secret fields when a profile edit submits their blank placeholders. */
export function preserveBlankPluginSecrets(
  definition: PluginDefinition,
  currentConfig: Record<string, PluginConfigValue>,
  nextConfig: Record<string, PluginConfigValue>
): Record<string, PluginConfigValue> {
  const preserved = { ...nextConfig };
  for (const field of definition.configSchema) {
    if (!field.secret) continue;
    const submitted = preserved[field.key];
    const current = currentConfig[field.key];
    if ((submitted === undefined || submitted === "") && typeof current === "string" && current) {
      preserved[field.key] = current;
    }
  }
  return preserved;
}
