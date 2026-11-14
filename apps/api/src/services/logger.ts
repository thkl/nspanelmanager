import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import winston from "winston";
import "winston-daily-rotate-file";
import type { HttpLogTransportSettings } from "../types.js";

/** Severity supported by manager log records and their configured sinks. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Structured log item passed to every manager log sink. */
export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  message: string;
  context: Readonly<Record<string, string>>;
}

/**
 * Receives a structured record from the manager logger.
 * Sinks may write synchronously to the console or asynchronously to durable
 * storage such as a rotating log file.
 */
export interface LogSink {
  /** Writes one log entry; rejected promises are isolated from application work. */
  write(record: LogRecord): void | Promise<void>;
  /** Flushes and closes resources when the API shuts down cleanly. */
  close?(): void | Promise<void>;
}

/** Formats manager records for the Node.js process console. */
export class ConsoleLogSink implements LogSink {
  /** Prints an ISO timestamp, severity, context fields, and message. */
  write(record: LogRecord): void {
    // JSON-quote context values so embedded spaces and punctuation remain distinguishable in plain-text output.
    const context = Object.entries(record.context).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(" ");
    const line = `[${record.timestamp}] [${record.level.toUpperCase()}]${context ? ` [${context}]` : ""} ${record.message}`;
    if (record.level === "debug") console.debug(line);
    else if (record.level === "info") console.info(line);
    else if (record.level === "warn") console.warn(line);
    else console.error(line);
  }
}

/** Writes structured records to private, size-limited, daily rotating JSON log files. */
export class WinstonFileLogSink implements LogSink {
  private readonly fileLogger: winston.Logger;
  private closed = false;

  /** Creates a protected log directory and configures rotation before serving requests. */
  static async create(directory: string): Promise<WinstonFileLogSink> {
    const resolvedDirectory = path.resolve(directory);
    await mkdir(resolvedDirectory, { recursive: true, mode: 0o700 });
    await chmod(resolvedDirectory, 0o700);
    return new WinstonFileLogSink(resolvedDirectory);
  }

  private constructor(directory: string) {
    // Keep rotation bounded and files private because integration logs can contain user-configured values.
    const transport = new winston.transports.DailyRotateFile({
      dirname: directory,
      filename: "manager-%DATE%.log",
      datePattern: "YYYY-MM-DD",
      maxSize: "10m",
      maxFiles: 20,
      zippedArchive: false,
      auditFile: path.join(directory, ".rotation-audit.json"),
      options: { flags: "a", mode: 0o600 },
      level: "debug"
    });
    transport.on("error", (error: unknown) => this.reportTransportFailure(error));
    this.fileLogger = winston.createLogger({
      level: "debug",
      format: winston.format.json(),
      transports: [transport],
      exitOnError: false
    });
  }

  /** Appends one JSON record while keeping Winston's fields separate from log context. */
  write(record: LogRecord): void {
    if (this.closed) return;
    this.fileLogger.log({
      level: record.level,
      message: record.message,
      timestamp: record.timestamp,
      context: record.context
    });
  }

  /** Waits for buffered file output to finish before process shutdown. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await new Promise<void>((resolve, reject) => {
      this.fileLogger.once("finish", resolve);
      this.fileLogger.once("error", reject);
      this.fileLogger.end();
    });
  }

  private reportTransportFailure(error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[logger] Rotating file transport failed: ${detail}`);
  }
}

/** Forwards structured records through Winston's built-in HTTP transport. */
export class WinstonHttpLogSink implements LogSink {
  private httpLogger?: winston.Logger;
  private lastFailureAt = 0;
  private suppressedFailures = 0;

  /** Replaces or disables the outgoing HTTP transport using the saved settings. */
  configure(settings: HttpLogTransportSettings): void {
    this.httpLogger?.close();
    this.httpLogger = undefined;
    if (!settings.enabled) return;

    const endpoint = parseHttpLogEndpoint(settings.url);
    const auth = settings.authType === "bearer"
      ? { bearer: settings.bearerToken }
      : settings.authType === "basic"
        ? { username: settings.username, password: settings.password }
        : undefined;
    const transport = new winston.transports.Http({
      host: endpoint.hostname,
      port: endpoint.port ? Number(endpoint.port) : undefined,
      path: `${endpoint.pathname}${endpoint.search}`,
      ssl: endpoint.protocol === "https:",
      auth,
      level: settings.level,
      batch: false
    });
    transport.on("warn", (error: unknown) => this.reportTransportFailure(error));
    this.httpLogger = winston.createLogger({
      level: "debug",
      format: winston.format.json(),
      transports: [transport],
      exitOnError: false
    });
  }

  /** Sends one record while preserving its timestamp and structured context. */
  write(record: LogRecord): void {
    this.httpLogger?.log({
      level: record.level,
      message: record.message,
      timestamp: record.timestamp,
      context: record.context
    });
  }

  /** Closes the outbound logger before the manager process exits. */
  close(): void {
    this.httpLogger?.close();
    this.httpLogger = undefined;
  }

  private reportTransportFailure(error: unknown): void {
    const now = Date.now();
    if (now - this.lastFailureAt < 60_000) {
      this.suppressedFailures += 1;
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    const suppressed = this.suppressedFailures;
    this.suppressedFailures = 0;
    this.lastFailureAt = now;
    console.error(`[logger] HTTP transport failed: ${detail}${suppressed ? ` (${suppressed} similar errors suppressed)` : ""}`);
  }
}

/**
 * Sends structured records to the configured sinks.
 * The API writes to the process console and adds a rotating Winston file sink
 * during startup without changing plugin or application logging calls.
 */
export class Logger {
  private readonly sinks: LogSink[];

  /** Creates the manager logger with console output unless sinks are supplied. */
  constructor(sinks: readonly LogSink[] = [new ConsoleLogSink()]) {
    this.sinks = [...sinks];
  }

  /** Adds a sink, such as a rotating file writer or optional HTTP transport, to receive new records. */
  addSink(sink: LogSink): void {
    this.sinks.push(sink);
  }

  /** Writes a diagnostic record, including plugin debug.log output. */
  debug(message: string, context: Record<string, string> = {}): void { this.write("debug", message, context); }

  /** Writes an informational manager record. */
  info(message: string, context: Record<string, string> = {}): void { this.write("info", message, context); }

  /** Writes a recoverable manager warning. */
  warn(message: string, context: Record<string, string> = {}): void { this.write("warn", message, context); }

  /** Writes a manager error without exposing exceptions to callers. */
  error(message: string, context: Record<string, string> = {}): void { this.write("error", message, context); }

  /** Closes asynchronous sinks after the application has emitted its final record. */
  async close(): Promise<void> {
    await Promise.all(this.sinks.map(async (sink) => {
      if (!sink.close) return;
      try { await sink.close(); }
      catch (error) { this.reportSinkFailure(error); }
    }));
  }

  private write(level: LogLevel, message: string, context: Record<string, string>): void {
    const record: LogRecord = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context: { ...context }
    };
    for (const sink of this.sinks) {
      // Logging is best-effort: a disk failure should not turn the original request or MQTT handler into a failure.
      try {
        const result = sink.write(record);
        if (result && typeof result.then === "function") {
          void result.catch((error: unknown) => this.reportSinkFailure(error));
        }
      } catch (error) {
        this.reportSinkFailure(error);
      }
    }
  }

  private reportSinkFailure(error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[logger] A log sink failed: ${detail}`);
  }
}

/** Validates the outbound destination before handing it to Winston's transport. */
function parseHttpLogEndpoint(value: string): URL {
  const endpoint = new URL(value);
  if (!(["http:", "https:"].includes(endpoint.protocol)) || !endpoint.hostname || endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error("The HTTP log destination must be an HTTP or HTTPS URL without embedded credentials or a fragment.");
  }
  return endpoint;
}
