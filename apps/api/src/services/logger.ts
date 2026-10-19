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
}

/** Formats manager records for the Node.js process console. */
export class ConsoleLogSink implements LogSink {
  /** Prints an ISO timestamp, severity, context fields, and message. */
  write(record: LogRecord): void {
    const context = Object.entries(record.context).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(" ");
    const line = `[${record.timestamp}] [${record.level.toUpperCase()}]${context ? ` [${context}]` : ""} ${record.message}`;
    if (record.level === "debug") console.debug(line);
    else if (record.level === "info") console.info(line);
    else if (record.level === "warn") console.warn(line);
    else console.error(line);
  }
}

/**
 * Sends structured records to the configured sinks.
 * The default sink writes to the API process console; additional sinks can be
 * attached later without changing plugin or application logging calls.
 */
export class Logger {
  private readonly sinks: LogSink[];

  /** Creates the manager logger with console output unless sinks are supplied. */
  constructor(sinks: readonly LogSink[] = [new ConsoleLogSink()]) {
    this.sinks = [...sinks];
  }

  /** Adds a sink, such as a future rotating file writer, to receive new records. */
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

  private write(level: LogLevel, message: string, context: Record<string, string>): void {
    const record: LogRecord = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context: { ...context }
    };
    for (const sink of this.sinks) {
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
