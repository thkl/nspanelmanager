import type { PluginVariables } from "../../types.js";

const VARIABLE_TOKEN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Replaces {{name}} tokens in MQTT topics, payloads, and other plain text. */
export function interpolatePluginTemplate(template: string, variables: PluginVariables): string {
  return template.replace(VARIABLE_TOKEN, (_token, name: string) => variables[name] ?? "");
}

/**
 * Resolves {{name}} tokens in JavaScript source before syntax checking or
 * execution. Values inside quoted strings are escaped for that quote style;
 * values in expressions become JSON string literals. Unknown names become an
 * empty string, and scripts can also read the complete map through `variables`.
 */
export function interpolatePluginScript(source: string, variables: PluginVariables): string {
  let output = "";
  let cursor = 0;
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  const matcher = new RegExp(VARIABLE_TOKEN.source, "g");
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(source)) !== null) {
    for (let index = cursor; index < match.index; index++) {
      const character = source[index];
      const next = source[index + 1];
      if (lineComment) {
        if (character === "\n") lineComment = false;
      } else if (blockComment) {
        if (character === "*" && next === "/") { blockComment = false; index++; }
      } else if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = undefined;
      } else if (character === "/" && next === "/") {
        lineComment = true;
        index++;
      } else if (character === "/" && next === "*") {
        blockComment = true;
        index++;
      } else if (character === "'" || character === '"' || character === "`") {
        quote = character;
      }
    }

    output += source.slice(cursor, match.index);
    const value = variables[match[1]] ?? "";
    output += quote ? escapeStringContents(value, quote) : JSON.stringify(value);
    cursor = matcher.lastIndex;
  }

  return output + source.slice(cursor);
}

function escapeStringContents(value: string, quote: "'" | '"' | "`"): string {
  let escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n");
  if (quote === "`") return escaped.replaceAll("`", "\\`").replaceAll("${", "\\${");
  escaped = escaped.replaceAll(quote, `\\${quote}`);
  return escaped;
}
