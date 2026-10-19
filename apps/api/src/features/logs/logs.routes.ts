import { Router } from "express";
import type { LogLevel } from "../../services/logger.js";
import { LogFileReader } from "./log-file-reader.js";

const MAX_LOG_LIMIT = 500;
const MAX_LOG_OFFSET = 20_000;

/** Creates authenticated log-query endpoints for the administrator workspace. */
export function createLogsRouter(logFileReader: LogFileReader): Router {
  const router = Router();
  router.get("/", async (request, response, next) => {
    const limit = parseLimit(request.query.limit);
    const offset = parseOffset(request.query.offset);
    const category = parseOptionalString(request.query.category);
    const level = parseLevel(request.query.level);
    if (limit === undefined) return response.status(400).json({ error: `limit must be an integer from 1 to ${MAX_LOG_LIMIT}.` });
    if (offset === undefined) return response.status(400).json({ error: `offset must be an integer from 0 to ${MAX_LOG_OFFSET}.` });
    if (category === null || category && !/^[a-z0-9._-]{1,64}$/i.test(category)) return response.status(400).json({ error: "category must contain only letters, numbers, dots, underscores, or hyphens." });
    if (level === null) return response.status(400).json({ error: "level must be debug, info, warn, or error." });

    try {
      response.setHeader("Cache-Control", "no-store");
      response.json(await logFileReader.read({ limit, offset, ...(category ? { category } : {}), ...(level ? { level } : {}) }));
    } catch (error) { next(error); }
  });
  return router;
}

function parseLimit(value: unknown): number | undefined {
  if (value === undefined) return 200;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_LOG_LIMIT ? limit : undefined;
}

function parseOffset(value: unknown): number | undefined {
  if (value === undefined) return 0;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const offset = Number(value);
  return Number.isSafeInteger(offset) && offset >= 0 && offset <= MAX_LOG_OFFSET ? offset : undefined;
}

function parseOptionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value.trim() : null;
}

function parseLevel(value: unknown): LogLevel | undefined | null {
  if (value === undefined || value === "") return undefined;
  return value === "debug" || value === "info" || value === "warn" || value === "error" ? value : null;
}
