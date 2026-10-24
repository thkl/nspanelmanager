import type { Logger } from "../../services/logger.js";
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
  private readonly schedule: CronSchedule;
  private timer?: NodeJS.Timeout;
  private lastScheduledMinute = "";
  private activeBackup?: Promise<void>;

  /** Validates the cron expression before the manager starts serving requests. */
  constructor(
    private readonly backups: BackupArchiveService,
    private readonly logger: Logger,
    readonly expression: string,
    private readonly retentionCount: number
  ) {
    this.schedule = parseCronExpression(expression);
    if (!Number.isSafeInteger(retentionCount) || retentionCount < 1) {
      throw new Error("BACKUP_RETENTION_COUNT must be a positive whole number.");
    }
  }

  /** Starts minute-aligned checks and runs immediately when the current minute matches. */
  start(): void {
    if (this.timer) return;
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

  /** Stops future cron checks and waits for an archive already being written. */
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.activeBackup;
  }

  private runIfDue(): void {
    const now = new Date();
    if (!matchesCron(this.schedule, now)) return;
    const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
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
}

function parseCronExpression(expression: string): CronSchedule {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("BACKUP_CRON must use five cron fields: minute hour day-of-month month day-of-week.");
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
    if (!part) throw new Error("BACKUP_CRON contains an empty cron value.");
    const pieces = part.split("/");
    if (pieces.length > 2) throw new Error(`BACKUP_CRON has an invalid step in '${part}'.`);
    const step = pieces.length === 2 ? Number(pieces[1]) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`BACKUP_CRON has an invalid step in '${part}'.`);

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
      throw new Error(`BACKUP_CRON has an invalid value '${range}'.`);
    }
    if (start < minimum || end > maximum || start > end) {
      throw new Error(`BACKUP_CRON value '${range}' is outside the supported range ${minimum}-${maximum}.`);
    }
    for (let value = start; value <= end; value += step) values.add(normalize(value));
  }
  if (!values.size) throw new Error("BACKUP_CRON must select at least one value in every field.");
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
