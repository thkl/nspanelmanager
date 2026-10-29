import type { Logger } from "../../services/logger.js";
import type { BackupSettings } from "../../types.js";
import { BackupArchiveService } from "./backup-archive-service.js";

interface CronField {
  values: ReadonlySet<number>;
  wildcard: boolean;
}

interface CronSchedule {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

/** Runs protected ZIP backups on a five-field cron schedule and records each outcome. */
export class BackupScheduler {
  private schedule: CronSchedule;
  private enabled: boolean;
  private expression: string;
  private retentionCount: number;
  private timer?: NodeJS.Timeout;
  private lastScheduledMinute = "";
  private activeBackup?: Promise<void>;

  /** Validates the cron expression before the manager starts serving requests. */
  constructor(
    private readonly backups: BackupArchiveService,
    private readonly logger: Logger,
    settings: BackupSettings
  ) {
    this.schedule = parseCronExpression(settings.schedule);
    validateRetentionCount(settings.retentionCount);
    this.enabled = settings.enabled;
    this.expression = settings.schedule;
    this.retentionCount = settings.retentionCount;
  }

  /** Starts minute-aligned checks for the settings loaded from manager configuration. */
  start(): void {
    this.startTimer();
  }

  /** Applies persisted UI settings, waiting for any in-progress archive before changing its destination. */
  async reconfigure(settings: BackupSettings): Promise<void> {
    const nextSchedule = parseCronExpression(settings.schedule);
    validateRetentionCount(settings.retentionCount);
    if (typeof settings.directory !== "string" || !settings.directory.trim()) throw new Error("Choose a backup folder.");

    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    try {
      await this.activeBackup;
      await this.backups.setBackupDirectory(settings.directory);
      this.schedule = nextSchedule;
      this.enabled = settings.enabled;
      this.expression = settings.schedule;
      this.retentionCount = settings.retentionCount;
      this.startTimer();
    } catch (error) {
      this.startTimer();
      throw error;
    }
  }

  /** Stops future cron checks and waits for an archive already being written. */
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.activeBackup;
  }

  private runIfDue(): void {
    if (!this.enabled) return;
    const now = new Date();
    if (!matchesCron(this.schedule, now)) return;
    const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
    // Polling more than once in a matching minute must not duplicate archives or overlap a slow backup.
    if (this.lastScheduledMinute === minuteKey || this.activeBackup) return;
    this.lastScheduledMinute = minuteKey;

    this.activeBackup = this.backups.createScheduledBackup(this.retentionCount).then((backup) => {
      this.logger.info("Scheduled ZIP backup created.", {
        component: "backup",
        filename: backup.filename,
        archiveBytes: String(backup.sizeBytes)
      });
    }).catch((error: unknown) => {
      this.logger.error("Scheduled ZIP backup failed.", {
        component: "backup",
        detail: error instanceof Error ? error.message : String(error)
      });
    }).finally(() => {
      this.activeBackup = undefined;
    });
  }

  private startTimer(): void {
    if (!this.enabled || this.timer) return;
    this.logger.info("Scheduled ZIP backups enabled.", {
      component: "backup",
      schedule: this.expression,
      retentionCount: String(this.retentionCount),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "system local"
    });
    this.timer = setInterval(() => this.runIfDue(), 15_000);
    this.timer.unref();
    this.runIfDue();
  }
}

function validateRetentionCount(retentionCount: number): void {
  if (!Number.isSafeInteger(retentionCount) || retentionCount < 1 || retentionCount > 365) {
    throw new Error("Keep between 1 and 365 scheduled backups.");
  }
}

function parseCronExpression(expression: string): CronSchedule {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("Use five schedule fields: minute hour day-of-month month day-of-week.");
  return {
    minute: parseCronField(fields[0], 0, 59),
    hour: parseCronField(fields[1], 0, 23),
    dayOfMonth: parseCronField(fields[2], 1, 31),
    month: parseCronField(fields[3], 1, 12),
    dayOfWeek: parseCronField(fields[4], 0, 7, (value) => value === 7 ? 0 : value)
  };
}

function parseCronField(source: string, minimum: number, maximum: number, normalize = (value: number): number => value): CronField {
  const values = new Set<number>();
  const wildcard = source === "*";
  for (const part of source.split(",")) {
    if (!part) throw new Error("The schedule contains an empty value.");
    const pieces = part.split("/");
    if (pieces.length > 2) throw new Error(`The schedule has an invalid step in '${part}'.`);
    const step = pieces.length === 2 ? Number(pieces[1]) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`The schedule has an invalid step in '${part}'.`);

    const range = pieces[0];
    let start: number;
    let end: number;
    if (range === "*") {
      start = minimum;
      end = maximum;
    } else if (/^\d+-\d+$/.test(range)) {
      [start, end] = range.split("-").map(Number);
    } else if (/^\d+$/.test(range)) {
      start = Number(range);
      end = pieces.length === 2 ? maximum : start;
    } else {
      throw new Error(`The schedule has an invalid value '${range}'.`);
    }
    if (start < minimum || end > maximum || start > end) {
      throw new Error(`Schedule value '${range}' is outside the supported range ${minimum}-${maximum}.`);
    }
    for (let value = start; value <= end; value += step) values.add(normalize(value));
  }
  if (!values.size) throw new Error("Choose at least one value in every schedule field.");
  return { values, wildcard };
}

function matchesCron(schedule: CronSchedule, date: Date): boolean {
  if (!schedule.minute.values.has(date.getMinutes()) || !schedule.hour.values.has(date.getHours()) ||
    !schedule.month.values.has(date.getMonth() + 1)) return false;
  const dayOfMonthMatches = schedule.dayOfMonth.values.has(date.getDate());
  const dayOfWeekMatches = schedule.dayOfWeek.values.has(date.getDay());
  const dayMatches = schedule.dayOfMonth.wildcard
    ? dayOfWeekMatches
    : schedule.dayOfWeek.wildcard
      ? dayOfMonthMatches
      : dayOfMonthMatches || dayOfWeekMatches;
  return dayMatches;
}
