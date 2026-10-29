import { Component, OnInit, signal } from "@angular/core";
import { TranslatePipe } from "@ngx-translate/core";
import type { AdminLogEntry, LogLevel } from "../../models";
import { ManagerStore } from "../../manager-store.service";

type LogLevelFilter = LogLevel | "all";

/** Shows recent rotating application logs with component and severity filters. */
@Component({
  selector: "nspanel-logs-page",
  standalone: true,
  imports: [TranslatePipe],
  templateUrl: "./logs-page.component.html",
  styleUrl: "./logs-page.component.css"
})
export class LogsPageComponent implements OnInit {
  readonly logs = signal<AdminLogEntry[]>([]);
  readonly categories = signal<string[]>([]);
  readonly category = signal("");
  readonly level = signal<LogLevelFilter>("all");
  readonly pageIndex = signal(0);
  readonly pageSize = signal(100);
  readonly hasMore = signal(false);
  readonly loading = signal(false);
  readonly error = signal("");
  readonly scanLimitReached = signal(false);
  private requestVersion = 0;

  /** Receives the typed API boundary used to retrieve records from rotating files. */
  constructor(private readonly manager: ManagerStore) {}

  /** Loads the latest entries when the administrator opens the logs workspace. */
  ngOnInit(): void { this.refresh(); }

  /** Fetches recent disk records using the active category and severity filters. */
  refresh(): void {
    const requestVersion = ++this.requestVersion;
    this.loading.set(true);
    this.error.set("");
    const selectedLevel = this.level();
    this.manager.loadLogs({
      limit: this.pageSize(),
      offset: this.pageIndex() * this.pageSize(),
      ...(this.category() ? { category: this.category() } : {}),
      ...(selectedLevel !== "all" ? { level: selectedLevel } : {})
    }).subscribe({
      next: (result) => {
        // Filter or page changes can overlap requests; only the newest selection may replace the visible rows.
        if (requestVersion !== this.requestVersion) return;
        this.logs.set(result.logs);
        this.categories.update((current) => [...new Set([...current, ...result.categories])].sort((left, right) => left.localeCompare(right)));
        this.hasMore.set(result.hasMore);
        this.scanLimitReached.set(result.scanLimitReached);
        this.loading.set(false);
      },
      error: () => {
        if (requestVersion !== this.requestVersion) return;
        this.error.set("LOGS.ERROR_LOAD");
        this.loading.set(false);
      }
    });
  }

  /** Updates the component category and reloads matching records from disk. */
  selectCategory(event: Event): void {
    this.category.set((event.target as HTMLSelectElement).value);
    this.pageIndex.set(0);
    this.refresh();
  }

  /** Updates the severity filter and reloads matching records from disk. */
  selectLevel(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (value === "all" || isLogLevel(value)) {
      this.level.set(value);
      this.pageIndex.set(0);
      this.refresh();
    }
  }

  /** Changes the visible page size and reloads from the newest matching entry. */
  selectPageSize(event: Event): void {
    const value = Number((event.target as HTMLSelectElement).value);
    if (value === 50 || value === 100 || value === 200) {
      this.pageSize.set(value);
      this.pageIndex.set(0);
      this.refresh();
    }
  }

  /** Loads the next page when the API found another matching entry. */
  nextPage(): void {
    if (this.loading() || !this.hasMore()) return;
    this.pageIndex.update((page) => page + 1);
    this.refresh();
  }

  /** Loads the previous page without changing the active filters. */
  previousPage(): void {
    if (this.loading() || this.pageIndex() === 0) return;
    this.pageIndex.update((page) => page - 1);
    this.refresh();
  }

  /** Formats timestamps in the administrator's local timezone. */
  formatTimestamp(value: string): string {
    const timestamp = new Date(value);
    return Number.isNaN(timestamp.getTime()) ? value : timestamp.toLocaleString();
  }

  /** Renders the structured diagnostic context as safely escaped JSON text. */
  formatContext(context: Record<string, string>): string { return JSON.stringify(context, null, 2); }

  /** Tells the template whether structured details are available to expand. */
  hasContext(context: Record<string, string>): boolean { return Object.keys(context).length > 0; }
}

function isLogLevel(value: string): value is LogLevel { return value === "debug" || value === "info" || value === "warn" || value === "error"; }
