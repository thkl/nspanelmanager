import { Router } from "express";
import type { ConfigStore } from "../services/config-store.js";
import type { Logger, WinstonHttpLogSink } from "../services/logger.js";
import type { HttpLogTransportSettings, PublicHttpLogTransportSettings } from "../types.js";

/** Provides authenticated settings for the manager's optional HTTP log sink. */
export function createLoggingRouter(store: ConfigStore, logger: Logger, httpLogSink: WinstonHttpLogSink): Router {
  const router = Router();

  router.put("/http", async (request, response) => {
    const previous = store.get().httpLogTransport;
    const parsed = parseHttpLogTransportSettings(request.body, previous);
    if (!parsed.settings) return response.status(400).json({ error: parsed.error });

    try {
      httpLogSink.configure(parsed.settings);
      await store.update((config) => {
        config.httpLogTransport = parsed.settings!;
      }, {
        actor: request.authUser?.email ?? "unknown",
        summary: "HTTP log transport settings changed"
      });
    } catch (error) {
      httpLogSink.configure(previous);
      throw error;
    }

    logger.info("HTTP log transport settings updated.", {
      component: "logging",
      enabled: String(parsed.settings.enabled),
      level: parsed.settings.level,
      authType: parsed.settings.authType,
      requestedBy: request.authUser?.email ?? "unknown"
    });
    return response.json({ httpLogTransport: presentHttpLogTransportSettings(parsed.settings) });
  });

  return router;
}

/** Applies safe form values while keeping an existing secret when its field is left blank. */
function parseHttpLogTransportSettings(
  value: unknown,
  previous: HttpLogTransportSettings
): { settings?: HttpLogTransportSettings; error?: string } {
  if (!isRecord(value)) return { error: "Enter valid HTTP logging settings." };
  const input = value;
  const levels = ["debug", "info", "warn", "error"] as const;
  const authTypes = ["none", "bearer", "basic"] as const;
  if (typeof input.enabled !== "boolean" || typeof input.url !== "string" ||
    !levels.includes(input.level as HttpLogTransportSettings["level"]) ||
    !authTypes.includes(input.authType as HttpLogTransportSettings["authType"])) {
    return { error: "Enter valid HTTP logging settings." };
  }

  const url = input.url.trim();
  if (url.length > 2048 || (url && !validHttpUrl(url))) {
    return { error: "Use a valid HTTP or HTTPS URL without embedded credentials or a fragment." };
  }
  const authType = input.authType as HttpLogTransportSettings["authType"];
  const authChanged = authType !== previous.authType;
  const usernameInput = boundedString(input.username, 512);
  const bearerTokenInput = boundedString(input.bearerToken, 4096);
  const passwordInput = boundedString(input.password, 4096);
  if (usernameInput === undefined || bearerTokenInput === undefined || passwordInput === undefined) {
    return { error: "An HTTP logging credential is longer than the allowed limit." };
  }

  const settings: HttpLogTransportSettings = {
    enabled: input.enabled,
    url,
    level: input.level as HttpLogTransportSettings["level"],
    authType,
    bearerToken: authType === "bearer"
      ? input.clearBearerToken === true ? "" : bearerTokenInput || (!authChanged ? previous.bearerToken : "")
      : "",
    username: authType === "basic"
      ? usernameInput.trim() || (!authChanged ? previous.username : "")
      : "",
    password: authType === "basic"
      ? input.clearPassword === true ? "" : passwordInput || (!authChanged ? previous.password : "")
      : ""
  };

  if (settings.enabled && !settings.url) return { error: "Enter an HTTP or HTTPS destination before enabling remote logging." };
  if (settings.enabled && settings.authType === "bearer" && !settings.bearerToken) {
    return { error: "Enter a bearer token before enabling remote logging." };
  }
  if (settings.enabled && settings.authType === "basic" && (!settings.username || !settings.password)) {
    return { error: "Enter both a username and password before enabling remote logging." };
  }
  return { settings };
}

/** Restricts destinations to plain HTTP or HTTPS URLs without inline user information. */
function validHttpUrl(value: string): boolean {
  try {
    const endpoint = new URL(value);
    return ["http:", "https:"].includes(endpoint.protocol) && Boolean(endpoint.hostname) &&
      !endpoint.username && !endpoint.password && !endpoint.hash;
  } catch {
    return false;
  }
}

/** Returns the settings that may be sent to a browser, replacing secrets with configured flags. */
function presentHttpLogTransportSettings(settings: HttpLogTransportSettings): PublicHttpLogTransportSettings {
  const { bearerToken, password, ...publicSettings } = settings;
  return {
    ...publicSettings,
    bearerTokenConfigured: Boolean(bearerToken),
    passwordConfigured: Boolean(password)
  };
}

function boundedString(value: unknown, maximumLength: number): string | undefined {
  if (value === undefined) return "";
  return typeof value === "string" && value.length <= maximumLength ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
