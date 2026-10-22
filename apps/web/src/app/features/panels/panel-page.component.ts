import { Component, DestroyRef, OnInit, inject, signal } from "@angular/core";
import { DatePipe } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { EMPTY, catchError, concatMap, from, interval, of, startWith, switchMap, toArray, type Observable } from "rxjs";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { ManagerStore } from "../../manager-store.service";
import type { Panel, PanelBinding, PanelTelemetry, PluginDefinition } from "../../models";
import { PanelScreenPreviewComponent } from "./panel-screen-preview.component";

/**
 * Edits the persisted per-panel display profile and favorite-to-plugin bindings.
 *
 * A panel's draft is a detached copy of the server record, so choosing another
 * panel or refreshing cannot silently mutate the shared manager state. Saving
 * synchronizes favorite bindings and persists the profile; applying publishes
 * the firmware's supported settings packet to the selected panel's settings topic.
 */
@Component({
  selector: "nspanel-panel-page",
  standalone: true,
  imports: [DatePipe, FormsModule, PanelScreenPreviewComponent],
  templateUrl: "./panel-page.component.html",
  styleUrl: "./panel-page.component.css"
})
export class PanelPageComponent implements OnInit {
  private readonly destroyRef = inject(DestroyRef);
  readonly selectedPanelId = signal<string | null>(null);
  readonly pluginDefinitions = signal<PluginDefinition[]>([]);
  readonly draft = signal<Panel | null>(null);
  readonly favoriteInstances = signal<Record<number, string>>({});
  readonly addingPanel = signal(false);
  readonly newName = signal("");
  readonly newNodeName = signal("");
  readonly saving = signal(false);

  /** Receives the shared API store used to load and persist panel profiles. */
  constructor(readonly manager: ManagerStore) {}

  /** Formats the latest firmware metrics for compact display in the panel list. */
  formatTelemetry(telemetry: PanelTelemetry): string {
    const parts: string[] = [];
    if (telemetry.firmwareVersion) parts.push(`FW ${telemetry.firmwareVersion}`);
    if (Number.isFinite(telemetry.uptimeSeconds)) parts.push(`Up ${formatUptime(telemetry.uptimeSeconds!)}`);
    if (Number.isFinite(telemetry.freeHeapBytes)) parts.push(`Free ${formatKilobytes(telemetry.freeHeapBytes!)} KB`);
    if (Number.isFinite(telemetry.minFreeHeapBytes)) parts.push(`Min ${formatKilobytes(telemetry.minFreeHeapBytes!)} KB`);
    if (Number.isFinite(telemetry.largestFreeBlockBytes)) parts.push(`Largest ${formatKilobytes(telemetry.largestFreeBlockBytes!)} KB`);
    if (Number.isFinite(telemetry.loopTimeMs)) parts.push(`Loop ${Math.round(telemetry.loopTimeMs!)} ms`);
    if (Number.isFinite(telemetry.chipTemperatureC)) parts.push(`Chip ${telemetry.chipTemperatureC!.toFixed(1)}°C`);
    return parts.join(" · ");
  }

  /** Loads the latest panel list and selects the current or first available panel. */
  ngOnInit(): void {
    this.refresh();
    this.manager.loadPlugins().subscribe({ next: ({ plugins }) => this.pluginDefinitions.set(plugins) });
    interval(15_000).pipe(
      startWith(0),
      switchMap(() => this.manager.refreshPanelConnections().pipe(catchError(() => EMPTY))),
      takeUntilDestroyed(this.destroyRef)
    ).subscribe();
  }

  /**
   * Reloads configuration, preserving the current selection where possible.
   *
   * The selected form is replaced with a fresh copy, so use this action only
   * after saving or when deliberately discarding edits.
   */
  refresh(): void {
    const previousId = this.selectedPanelId();
    this.manager.refresh().subscribe({
      next: ({ config }) => {
        const next = config.panels.find((panel) => panel.id === previousId) ?? config.panels[0] ?? null;
        this.setDraft(next);
      },
      error: () => this.manager.inform("Could not load panel configuration.", "error")
    });
  }

  /** Switches the editor to a separate copy of the chosen panel. */
  selectPanel(panel: Panel): void { this.setDraft(panel); }

  /** Creates a new panel profile from the user-visible name and firmware node name. */
  addPanel(): void {
    const name = this.newName().trim();
    const nodeName = this.newNodeName().trim();
    this.manager.addPanel({ name, nodeName }).subscribe({
      next: ({ panel }) => {
        this.setDraft(panel);
        this.newName.set("");
        this.newNodeName.set("");
        this.addingPanel.set(false);
        this.manager.inform("Panel added. Save its settings, then apply them when the panel is online.");
      },
      error: (error) => this.manager.inform(error.error?.error || "Could not add panel.", "error")
    });
  }

  /** Synchronizes favorite bindings, saves the profile, and refreshes the draft. */
  savePanel(): void {
    const current = this.draft();
    if (!current || !this.favoritesValid(current)) return;
    this.saving.set(true);
    this.persistPanelDraft(current).subscribe({
      next: ({ panel: saved, published, topic }) => {
        this.setDraft(saved);
        this.saving.set(false);
        this.manager.inform(published ? `Panel settings saved and sent to ${topic}.` : "Panel settings saved; they will be sent when MQTT reconnects.");
      },
      error: (error) => { this.saving.set(false); this.manager.inform(error.error?.error || "Could not save panel settings or favorite bindings.", "error"); }
    });
  }

  /** Returns the plugin instance currently assigned to one favorite slot. */
  favoriteInstance(index: number): string {
    const id = this.favoriteInstances()[index] ?? "";
    return this.favoritePluginInstances().some((instance) => instance.id === id) ? id : "";
  }

  /** Updates the unsaved plugin instance selection for one favorite slot. */
  setFavoriteInstance(index: number, pluginInstanceId: string): void {
    this.favoriteInstances.update((assignments) => ({ ...assignments, [index]: pluginInstanceId }));
  }

  /** Lists plugin definitions that integrate with firmware-owned panel screens. */
  nativePanelPlugins(): PluginDefinition[] {
    return this.pluginDefinitions().filter((plugin) => Boolean(plugin.nativePanelPage));
  }

  /** Lists integrations that can observe panel page changes, such as the screen dimmer. */
  panelEventObserverPlugins(): PluginDefinition[] {
    return this.pluginDefinitions().filter((plugin) => Boolean(plugin.panelEventObserver));
  }

  /** Lists enabled instances of one event-observer plugin for panel assignment. */
  panelEventInstances(pluginId: string) {
    const plugin = this.pluginDefinitions().find((candidate) => candidate.id === pluginId);
    const pluginIds = new Set(plugin ? [plugin.id, ...(plugin.aliases ?? [])] : [pluginId]);
    const profileIds = new Set(this.manager.config().pluginProfiles
      .filter((profile) => pluginIds.has(profile.pluginId))
      .map((profile) => profile.id));
    return this.manager.config().pluginInstances.filter((instance) => instance.enabled && profileIds.has(instance.pluginProfileId));
  }

  /** Lists enabled configuration instances that support one firmware-owned page. */
  nativePageInstances(pageId: string) {
    const pluginIds = new Set(this.nativePanelPlugins()
      .filter((plugin) => plugin.nativePanelPage === pageId)
      .map((plugin) => plugin.id));
    const profileIds = new Set(this.manager.config().pluginProfiles
      .filter((profile) => pluginIds.has(profile.pluginId))
      .map((profile) => profile.id));
    return this.manager.config().pluginInstances.filter((instance) => instance.enabled && profileIds.has(instance.pluginProfileId));
  }

  /** Lists enabled instances that expose a favorite flow, including firmware-native pages. */
  favoritePluginInstances() {
    const favoritePluginIds = new Set(this.pluginDefinitions().filter((plugin) => plugin.favoriteFlow).flatMap((plugin) => [plugin.id, ...(plugin.aliases ?? [])]));
    const favoriteProfileIds = new Set(this.manager.config().pluginProfiles.filter((profile) => favoritePluginIds.has(profile.pluginId)).map((profile) => profile.id));
    return this.manager.config().pluginInstances.filter((instance) => instance.enabled && favoriteProfileIds.has(instance.pluginProfileId));
  }

  /** Returns the instance assigned to a firmware-owned screen, if any. */
  nativePageInstance(pageId: string): string { return this.draft()?.nativePluginInstances?.[pageId] ?? ""; }

  /** Assigns or clears an instance for one firmware-owned screen. */
  setNativePageInstance(pageId: string, pluginInstanceId: string): void {
    const panel = this.draft();
    if (!panel) return;
    const nativePluginInstances = { ...(panel.nativePluginInstances ?? {}) };
    if (pluginInstanceId) nativePluginInstances[pageId] = pluginInstanceId;
    else delete nativePluginInstances[pageId];
    panel.nativePluginInstances = nativePluginInstances;
  }

  /** Returns the assigned observer instance for one plugin definition. */
  panelEventInstance(pluginId: string): string {
    return this.draft()?.panelEventPluginInstances?.[pluginId] ?? "";
  }

  /** Assigns or clears one panel page-event observer instance in the unsaved draft. */
  setPanelEventInstance(pluginId: string, pluginInstanceId: string): void {
    const panel = this.draft();
    if (!panel) return;
    const assignments = { ...(panel.panelEventPluginInstances ?? {}) };
    if (pluginInstanceId) assignments[pluginId] = pluginInstanceId;
    else delete assignments[pluginId];
    panel.panelEventPluginInstances = assignments;
  }

  /** Provides a friendly page label for the firmware-native integration selector. */
  nativePageLabel(pageId: string): string {
    if (pageId === "thermostat") return "Thermostat page";
    if (pageId === "weather") return "Weather screen";
    if (pageId === "music") return "Music page";
    return `${pageId} page`;
  }

  /** Lists enabled or saved instances whose plugin can drive a main-screen tile. */
  homeTileInstances() {
    const pluginIds = new Set(this.pluginDefinitions().filter((plugin) => plugin.homeTileType).map((plugin) => plugin.id));
    const profileIds = new Set(this.manager.config().pluginProfiles.filter((profile) => pluginIds.has(profile.pluginId)).map((profile) => profile.id));
    return this.manager.config().pluginInstances.filter((instance) => profileIds.has(instance.pluginProfileId));
  }

  /** Returns the configured light or cover capability for an assigned instance. */
  homeTileType(pluginInstanceId?: string): "light" | "cover" | undefined {
    const instance = this.homeTileInstances().find((candidate) => candidate.id === pluginInstanceId);
    const profile = instance && this.manager.config().pluginProfiles.find((candidate) => candidate.id === instance.pluginProfileId);
    return this.pluginDefinitions().find((plugin) => plugin.id === profile?.pluginId)?.homeTileType;
  }

  /** Assigns an instance and chooses its built-in detail page as the initial action. */
  setHomeTileInstance(index: number, pluginInstanceId: string): void {
    const panel = this.draft();
    const button = panel?.settings.buttons[index];
    if (!button) return;
    if (pluginInstanceId) button.pluginInstanceId = pluginInstanceId;
    else delete button.pluginInstanceId;
    const type = this.homeTileType(pluginInstanceId);
    if (type === "cover") button.mode = 1;
    else if (type === "light") button.mode = 0;
  }

  /** Requires a readable shortcut label whenever a plugin instance is assigned. */
  favoritesValid(panel: Panel): boolean {
    return panel.settings.favorites.buttons.every((favorite, index) =>
      !this.favoriteInstance(index) || Boolean(favorite.label.trim())
    );
  }

  /** Saves the current editor draft and publishes it to the selected panel. */
  applyPanel(): void {
    const panel = this.draft();
    if (!panel || !this.favoritesValid(panel)) return;
    this.saving.set(true);
    this.persistPanelDraft(panel).pipe(
      switchMap(({ panel: saved, published, topic }) => {
        this.setDraft(saved);
        return published ? of({ topic }) : this.manager.applyPanel(saved);
      })
    ).subscribe({
      next: ({ topic }) => {
        this.saving.set(false);
        this.manager.inform(`Settings sent to ${topic}.`);
      },
      error: (error) => {
        this.saving.set(false);
        this.manager.inform(error.error?.error || "Could not apply panel settings.", "error");
      }
    });
  }

  /** Removes a panel after confirmation and resets the selected editor. */
  removePanel(): void {
    const panel = this.draft();
    if (!panel || !confirm(`Remove ${panel.name} and its associated routes?`)) return;
    this.manager.removePanel(panel).subscribe({
      next: () => {
        const next = this.manager.config().panels[0] ?? null;
        this.setDraft(next);
        this.manager.inform("Panel removed.");
      },
      error: () => this.manager.inform("Could not remove panel.", "error")
    });
  }

  private setDraft(panel: Panel | null): void {
    this.selectedPanelId.set(panel?.id ?? null);
    this.draft.set(panel ? structuredClone(panel) : null);
    const assignments = panel
      ? this.manager.config().panelBindings
        .filter((binding) => binding.panelId === panel.id && binding.trigger.type === "favorite")
        .map((binding) => [binding.trigger.index, binding.pluginInstanceId] as const)
      : [];
    this.favoriteInstances.set(Object.fromEntries(assignments));
  }

  /** Builds sequential add/remove requests for changed favorite assignments. */
  private panelBindingOperations(panel: Panel): Observable<unknown>[] {
    const existingBindings = this.manager.config().panelBindings.filter((binding) => binding.panelId === panel.id);
    const operations: Observable<unknown>[] = [];
    for (const [index, favorite] of panel.settings.favorites.buttons.entries()) {
      const existing = existingBindings.find((binding) => binding.trigger.index === index);
      const pluginInstanceId = this.favoriteInstance(index);
      const name = favorite.label.trim();
      if (existing?.pluginInstanceId === pluginInstanceId && existing.name === name) continue;
      if (existing) operations.push(this.manager.removePanelBinding(existing));
      if (pluginInstanceId) {
        operations.push(this.manager.addPanelBinding({ name, panelId: panel.id, pluginInstanceId, favoriteIndex: index }));
      }
    }
    return operations;
  }

  /** Saves the current editor draft, synchronizing favorite bindings before the panel profile. */
  private persistPanelDraft(current: Panel): Observable<{ panel: Panel; published: boolean; topic: string }> {
    const panel = structuredClone(current);
    panel.settings.favorites.buttons = panel.settings.favorites.buttons.map((favorite, index) =>
      this.favoriteInstance(index)
        ? { ...favorite, label: favorite.label.trim(), mode: 0 }
        : favorite
    );
    return from(this.panelBindingOperations(panel)).pipe(
      concatMap((operation) => operation),
      toArray(),
      switchMap(() => this.manager.savePanel(panel))
    );
  }
}

function formatUptime(seconds: number): string {
  const totalMinutes = Math.floor(Math.max(0, seconds) / 60);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatKilobytes(bytes: number): string {
  return (bytes / 1_024).toFixed(1);
}
