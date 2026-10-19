import { Component, OnInit, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { concatMap, from, switchMap, toArray, type Observable } from "rxjs";
import { ManagerStore } from "../../manager-store.service";
import type { Panel, PanelBinding, PluginDefinition } from "../../models";

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
  imports: [FormsModule],
  templateUrl: "./panel-page.component.html",
  styleUrl: "./panel-page.component.css"
})
export class PanelPageComponent implements OnInit {
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

  /** Loads the latest panel list and selects the current or first available panel. */
  ngOnInit(): void {
    this.refresh();
    this.manager.loadPlugins().subscribe({ next: ({ plugins }) => this.pluginDefinitions.set(plugins) });
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
    const panel = structuredClone(current);
    panel.settings.favorites.buttons = panel.settings.favorites.buttons.map((favorite, index) =>
      this.favoriteInstance(index)
        ? { ...favorite, label: favorite.label.trim(), mode: 0 }
        : favorite
    );
    this.saving.set(true);
    from(this.panelBindingOperations(panel)).pipe(
      concatMap((operation) => operation),
      toArray(),
      switchMap(() => this.manager.savePanel(panel))
    ).subscribe({
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

  /** Lists enabled configuration instances that support one firmware-owned page. */
  nativePageInstances(pageId: string) {
    const pluginIds = new Set(this.nativePanelPlugins()
      .filter((plugin) => plugin.nativePanelPage === pageId)
      .map((plugin) => plugin.id));
    const profileIds = new Set(this.manager.config().pluginProfiles
      .filter((profile) => pluginIds.has(profile.pluginId))
      .map((profile) => profile.id));
    return this.manager.config().pluginInstances.filter((instance) => profileIds.has(instance.pluginProfileId));
  }

  /** Lists instances that can be launched through the generic favorite/info page flow. */
  favoritePluginInstances() {
    const nativePluginIds = new Set(this.pluginDefinitions().filter((plugin) => plugin.nativePanelPage).map((plugin) => plugin.id));
    const nativeProfileIds = new Set(this.manager.config().pluginProfiles.filter((profile) => nativePluginIds.has(profile.pluginId)).map((profile) => profile.id));
    return this.manager.config().pluginInstances.filter((instance) => !nativeProfileIds.has(instance.pluginProfileId));
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

  /** Provides a friendly page label for the firmware-native integration selector. */
  nativePageLabel(pageId: string): string {
    if (pageId === "thermostat") return "Thermostat page";
    if (pageId === "weather") return "Weather screen";
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

  /** Publishes the saved profile to the selected panel over the active broker connection. */
  applyPanel(): void {
    const panel = this.draft();
    if (!panel) return;
    this.manager.applyPanel(panel).subscribe({
      next: ({ topic }) => this.manager.inform(`Settings sent to ${topic}.`),
      error: (error) => this.manager.inform(error.error?.error || "Could not apply panel settings.", "error")
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
}
