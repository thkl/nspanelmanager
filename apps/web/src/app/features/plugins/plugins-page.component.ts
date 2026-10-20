import { Component, OnInit, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { ManagerStore } from "../../manager-store.service";
import type { PluginConfigField, PluginConfigValue, PluginDefinition, PluginInstance, PluginInstanceDraft, PluginPagePreviewResult, PluginProfile, PluginProfileDraft } from "../../models";
import { ScriptEditorComponent } from "./script-editor.component";

const SCRIPTED_PLUGIN_ID = "mqtt-scripted";

interface ScriptCheckState {
  source: string;
  status: "checking" | "valid" | "invalid";
  message: string;
}

interface PageActionEntry {
  index: number;
  action: Record<string, string>;
}

/**
 * Configures reusable plugin profiles and per-device instances. Registry
 * schemas drive the profile editor; panel favorite bindings live with panels.
 */
@Component({
  selector: "nspanel-plugins-page",
  standalone: true,
  imports: [FormsModule, ScriptEditorComponent],
  templateUrl: "./plugins-page.component.html",
  styleUrl: "./plugins-page.component.css"
})
export class PluginsPageComponent implements OnInit {
  readonly definitions = signal<PluginDefinition[]>([]);
  readonly selectedPluginId = signal("");
  readonly profileName = signal("");
  readonly editingProfileId = signal<string | null>(null);
  readonly activePageIndex = signal(0);
  readonly activeFunctionIndex = signal(0);
  readonly expandedButtonPageIndexes = signal<Set<number>>(new Set());
  readonly selectedPluginProfileId = signal("");
  readonly instanceName = signal("");
  readonly instanceConfig = signal<Record<string, PluginConfigValue>>({});
  readonly instanceVariables = signal<Record<string, string>>({});
  readonly editingInstanceId = signal<string | null>(null);
  readonly previewPageId = signal("overview");
  readonly previewTopic = signal("home/device/state");
  readonly previewPayload = signal("{}");
  readonly previewingPage = signal(false);
  readonly pagePreview = signal<PluginPagePreviewResult | null>(null);
  readonly pagePreviewError = signal("");
  readonly scriptChecks = signal<Record<string, ScriptCheckState>>({});
  readonly savingInstance = signal(false);
  readonly savingProfile = signal(false);
  readonly buttonSlots = Array.from({ length: 8 }, (_, index) => String(index + 1));

  /** Provides shared configuration and typed API operations for this page. */
  constructor(readonly manager: ManagerStore) {}

  /** Loads plugin schemas and the saved instance and binding lists. */
  ngOnInit(): void { this.refresh(); }

  /** Refreshes saved configuration and obtains the schemas for dynamic forms. */
  refresh(): void {
    this.manager.refresh().subscribe({
      next: () => {
        const firstProfile = this.manager.config().pluginProfiles[0];
        if (!this.selectedPluginProfileId() && firstProfile) this.setInstanceProfile(firstProfile.id);
      },
      error: () => this.manager.inform("Could not load plugin configuration.", "error")
    });
    this.manager.loadPlugins().subscribe({
      next: ({ plugins }) => {
        this.definitions.set(plugins);
        if (this.selectedPluginProfileId()) this.setInstanceProfile(this.selectedPluginProfileId());
        if (!plugins.some((plugin) => plugin.id === this.selectedPluginId())) this.selectPlugin(plugins[0]?.id ?? "");
      },
      error: () => this.manager.inform("Could not load registered plugins.", "error")
    });
  }

  /** Returns the schema currently selected for a new or edited reusable plugin. */
  get selectedDefinition(): PluginDefinition | undefined {
    return this.definitions().find((definition) => definition.id === this.selectedPluginId());
  }

  /** Selects a plugin implementation and initializes its reusable profile fields. */
  selectPlugin(pluginId: string): void {
    this.selectedPluginId.set(pluginId);
    this.activePageIndex.set(0);
    this.activeFunctionIndex.set(0);
    this.expandedButtonPageIndexes.set(new Set());
    const definition = this.definitions().find((item) => item.id === pluginId);
    const config = Object.fromEntries((definition?.configSchema ?? []).map((field) => [field.key, field.defaultValue]));
    this.instanceConfig.set(config);
    this.scriptChecks.set({});
    this.syncPreviewDefaults(config);
    this.clearPagePreview();
  }

  /** Updates one schema-driven config value while retaining all other fields. */
  setConfigValue(field: PluginConfigField, value: unknown): void {
    let normalized: PluginConfigValue;
    if (field.type === "number") {
      // Dynamic input types can emit strings because Angular selects value accessors from static attributes.
      const parsedValue = typeof value === "number"
        ? value
        : typeof value === "string" && value.trim() !== "" ? Number(value) : 0;
      normalized = Number.isFinite(parsedValue) ? parsedValue : 0;
    } else {
      normalized = typeof value === "string" ? value : "";
    }
    this.instanceConfig.update((config) => {
      const updated = { ...config, [field.key]: normalized };
      const table = this.selectedDefinition?.configSchema.find((candidate) => candidate.type === "table" && candidate.rowCountKey === field.key);
      if (table && typeof normalized === "number") {
        const count = Math.min(table.maxRows ?? 8, Math.max(table.minRows ?? 1, Math.trunc(normalized)));
        updated[table.key] = JSON.stringify(this.resizeTableRows(updated[table.key], table, count));
      }
      return updated;
    });
    if (field.key === "topicFilters" && typeof normalized === "string") {
      this.previewTopic.set(normalized.split(/\r?\n/).map((topic) => topic.trim()).find(Boolean) ?? "");
    }
    if (field.key === "startPage" && typeof normalized === "string") this.previewPageId.set(normalized);
    if (this.isScriptField(field)) {
      this.scriptChecks.update((checks) => {
        const next = { ...checks };
        delete next[this.scriptFieldCheckKey(field)];
        return next;
      });
    }
    this.clearPagePreview();
  }

  /** Reads a table field's string-backed rows for display in the generic editor. */
  tableRows(field: PluginConfigField): Record<string, string>[] {
    return this.parseTableRows(this.instanceConfig()[field.key], field);
  }

  /** Identifies the scripted plugin's pages table, which uses page tabs instead of a flat table. */
  isTabbedPageField(field: PluginConfigField): boolean {
    return this.selectedPluginId() === SCRIPTED_PLUGIN_ID && field.key === "pages";
  }

  /** Identifies the scripted plugin's button table, rendered within each page tab. */
  isTabbedButtonActionField(field: PluginConfigField): boolean {
    return this.selectedPluginId() === SCRIPTED_PLUGIN_ID && field.key === "buttonActions";
  }

  /** Identifies the reusable helper table, which uses tabs instead of a row list. */
  isTabbedFunctionField(field: PluginConfigField): boolean {
    return this.selectedPluginId() === SCRIPTED_PLUGIN_ID && field.key === "functions";
  }

  /** Returns the active page row from the scripted plugin's page table. */
  activePage(field: PluginConfigField): Record<string, string> | undefined {
    return this.tableRows(field)[this.activePageIndex()];
  }

  /** Selects the page tab whose fields and button actions should be shown. */
  selectPage(index: number): void {
    if (Number.isInteger(index) && index >= 0) this.activePageIndex.set(index);
  }

  /** Returns the selected helper function from the scripted plugin's function table. */
  activeFunction(field: PluginConfigField): Record<string, string> | undefined {
    return this.tableRows(field)[this.activeFunctionIndex()];
  }

  /** Selects the helper tab whose fields and JavaScript body should be shown. */
  selectFunction(index: number): void {
    if (Number.isInteger(index) && index >= 0) this.activeFunctionIndex.set(index);
  }

  /** Adds a helper with a unique ID and opens its editor tab. */
  addFunction(field: PluginConfigField): void {
    const functions = this.tableRows(field);
    if (functions.length >= (field.maxRows ?? 32)) return;
    const functionIds = new Set(functions.map((fn) => fn["id"]));
    let id = `helper-${functions.length + 1}`;
    let suffix = functions.length + 1;
    while (functionIds.has(id)) id = `helper-${++suffix}`;
    const row = Object.fromEntries((field.columns ?? []).map((column) => [column.key, ""]));
    row["id"] = id;
    row["code"] = "return message;";
    functions.push(row);
    this.setConfigValue(field, JSON.stringify(functions));
    this.activeFunctionIndex.set(functions.length - 1);
  }

  /** Updates a helper field and keeps any button references valid after an ID rename. */
  setFunctionCell(field: PluginConfigField, rowIndex: number, columnKey: string, value: unknown): void {
    const previousId = this.tableRows(field)[rowIndex]?.["id"];
    if (previousId === undefined || !field.columns?.some((column) => column.key === columnKey)) return;
    const nextValue = typeof value === "string" ? value : "";
    this.setTableCell(field, rowIndex, columnKey, nextValue);
    if (columnKey === "id" && previousId && previousId !== nextValue) this.renameFunctionReferences(previousId, nextValue);
  }

  /** Removes a helper and clears button actions that referenced its ID. */
  removeFunction(field: PluginConfigField, rowIndex: number): void {
    const functions = this.tableRows(field);
    if (rowIndex < 0 || rowIndex >= functions.length) return;
    const removedId = functions[rowIndex]["id"];
    functions.splice(rowIndex, 1);
    this.setConfigValue(field, JSON.stringify(functions));
    const actionsField = this.buttonActionsField();
    if (actionsField && removedId) {
      const actions = this.tableRows(actionsField).map((action) =>
        action["type"] === "function" && action["target"] === removedId
          ? { ...action, type: "none", target: "" }
          : action
      );
      this.setConfigValue(actionsField, JSON.stringify(actions));
    }
    this.activeFunctionIndex.set(Math.max(0, Math.min(rowIndex < this.activeFunctionIndex() ? this.activeFunctionIndex() - 1 : this.activeFunctionIndex(), functions.length - 1)));
    this.scriptChecks.set({});
  }

  /** Reports whether the active page's button actions are expanded. */
  arePageButtonsExpanded(pageIndex: number): boolean {
    return this.expandedButtonPageIndexes().has(pageIndex);
  }

  /** Toggles the active page's button action editor. */
  togglePageButtons(pageIndex: number): void {
    this.expandedButtonPageIndexes.update((expanded) => {
      const next = new Set(expanded);
      if (next.has(pageIndex)) next.delete(pageIndex);
      else next.add(pageIndex);
      return next;
    });
  }

  /** Finds the schema field that stores button actions grouped by page ID. */
  buttonActionsField(): PluginConfigField | undefined {
    return this.selectedDefinition?.configSchema.find((field) => field.key === "buttonActions");
  }

  /** Returns button actions for one page together with their indexes in saved configuration. */
  pageActions(field: PluginConfigField, pageId: string): PageActionEntry[] {
    return this.tableRows(field).flatMap((action, index) => action.pageId === pageId ? [{ index, action }] : []);
  }

  /** Returns configured functions as selectable targets for a page button. */
  pageFunctionTargets(): Record<string, string>[] {
    const field = this.selectedDefinition?.configSchema.find((candidate) => candidate.key === "functions");
    return field ? this.tableRows(field).filter((row) => Boolean(row.id.trim())) : [];
  }

  /** Adds a ready-to-edit page with a safe unique ID and starter renderer. */
  addPage(field: PluginConfigField): void {
    const rows = this.tableRows(field);
    if (rows.length >= (field.maxRows ?? 16)) return;
    const pageNumber = rows.length + 1;
    const pageIds = new Set(rows.map((row) => row.id));
    let id = `page-${pageNumber}`;
    let suffix = pageNumber;
    while (pageIds.has(id)) id = `page-${++suffix}`;
    const row = Object.fromEntries((field.columns ?? []).map((column) => [column.key, ""]));
    row["id"] = id;
    row["name"] = `Page ${pageNumber}`;
    row["renderCode"] = `return { title: "Page ${pageNumber}", message: "", buttons: [] };`;
    rows.push(row);
    this.setConfigValue(field, JSON.stringify(rows));
    this.activePageIndex.set(rows.length - 1);
  }

  /** Saves a page field and keeps its button references valid when its ID changes. */
  setPageCell(field: PluginConfigField, rowIndex: number, columnKey: string, value: unknown): void {
    const rows = this.tableRows(field).map((row) => ({ ...row }));
    if (!rows[rowIndex] || !field.columns?.some((column) => column.key === columnKey)) return;
    const previousId = rows[rowIndex]["id"];
    const nextValue = typeof value === "string" ? value : "";
    rows[rowIndex][columnKey] = nextValue;
    const checkKey = this.scriptCheckKey(field, rowIndex, columnKey);
    this.scriptChecks.update((checks) => {
      const next = { ...checks };
      delete next[checkKey];
      return next;
    });
    this.setConfigValue(field, JSON.stringify(rows));
    if (columnKey === "id" && previousId && previousId !== nextValue) this.renamePageReferences(previousId, nextValue);
  }

  /** Removes a page and clears or updates references that would otherwise become invalid. */
  removePage(field: PluginConfigField, rowIndex: number): void {
    const pages = this.tableRows(field);
    if (pages.length <= (field.minRows ?? 1) || rowIndex < 0 || rowIndex >= pages.length) return;
    const removedId = pages[rowIndex]["id"];
    pages.splice(rowIndex, 1);
    const nextStartPage = pages[0]?.["id"] ?? "";
    this.setConfigValue(field, JSON.stringify(pages));

    const actionsField = this.buttonActionsField();
    if (actionsField) {
      const actions = this.tableRows(actionsField)
        .filter((action) => action["pageId"] !== removedId)
        .map((action) => action["type"] === "page" && action["target"] === removedId ? { ...action, target: "" } : action);
      this.setConfigValue(actionsField, JSON.stringify(actions));
    }

    const startPageField = this.selectedDefinition?.configSchema.find((candidate) => candidate.key === "startPage");
    if (startPageField && this.instanceConfig()["startPage"] === removedId) this.setConfigValue(startPageField, nextStartPage);
    if (this.previewPageId() === removedId) this.previewPageId.set(nextStartPage);
    this.activePageIndex.set(Math.max(0, Math.min(rowIndex < this.activePageIndex() ? this.activePageIndex() - 1 : this.activePageIndex(), pages.length - 1)));
    this.expandedButtonPageIndexes.update((expanded) => new Set([...expanded].flatMap((index) =>
      index === rowIndex ? [] : [index < rowIndex ? index : index - 1]
    )));
    this.scriptChecks.set({});
  }

  /** Reports whether another action can be assigned to this page's eight button slots. */
  canAddPageAction(field: PluginConfigField, pageId: string): boolean {
    return Boolean(pageId) && this.pageActions(field, pageId).length < this.buttonSlots.length;
  }

  /** Prevents two actions on the same page from claiming the same physical button. */
  pageActionSlotUsed(field: PluginConfigField, pageId: string, slot: string, currentIndex: number): boolean {
    return this.pageActions(field, pageId).some((entry) => entry.index !== currentIndex && entry.action.slot === slot);
  }

  /** Adds an action to the first unused button slot on the selected page. */
  addPageAction(field: PluginConfigField, pageId: string): void {
    const actions = this.tableRows(field);
    const currentPageActions = actions.filter((action) => action["pageId"] === pageId);
    if (!pageId || currentPageActions.length >= this.buttonSlots.length) return;
    const usedSlots = new Set(currentPageActions.map((action) => action["slot"]));
    const slot = this.buttonSlots.find((candidate) => !usedSlots.has(candidate));
    if (!slot) return;
    actions.push({ pageId, slot, type: "none", target: "", topic: "", payload: "" });
    this.setConfigValue(field, JSON.stringify(actions));
    this.expandedButtonPageIndexes.update((expanded) => new Set(expanded).add(this.activePageIndex()));
  }

  /** Updates a page button's selected slot, target, topic, or payload. */
  setPageActionCell(field: PluginConfigField, rowIndex: number, columnKey: string, value: unknown): void {
    this.setTableCell(field, rowIndex, columnKey, value);
  }

  /** Changes a page button's action type and clears the type-specific target. */
  setPageActionType(field: PluginConfigField, rowIndex: number, value: string): void {
    if (!["none", "page", "mqtt", "function"].includes(value)) return;
    const actions = this.tableRows(field).map((action) => ({ ...action }));
    if (!actions[rowIndex]) return;
    actions[rowIndex]["type"] = value;
    actions[rowIndex]["target"] = "";
    this.setConfigValue(field, JSON.stringify(actions));
  }

  /** Removes one page button action from the shared configuration list. */
  removePageAction(field: PluginConfigField, rowIndex: number): void {
    this.removeTableRow(field, rowIndex);
  }

  /** Resolves fixed, linked, or configured plugin-instance values for a table cell. */
  tableColumnOptions(field: PluginConfigField, columnKey: string, row: Record<string, string>): string[] | undefined {
    const column = field.columns?.find((candidate) => candidate.key === columnKey);
    if (column?.options?.length) return [...column.options];
    if (column?.optionSource === "plugin-instances") {
      const configuredIds = this.manager.config().pluginInstances
        .filter((instance) => instance.enabled)
        .filter((instance) => {
          const profile = this.manager.config().pluginProfiles.find((item) => item.id === instance.pluginProfileId);
          return this.definitions().some((definition) => definition.favoriteFlow && [definition.id, ...(definition.aliases ?? [])].includes(profile?.pluginId ?? ""));
        })
        .map((instance) => instance.id);
      const selectedId = row[columnKey];
      return selectedId && !configuredIds.includes(selectedId) ? [...configuredIds, selectedId] : configuredIds;
    }
    if (field.key !== "buttonActions") return undefined;
    if (columnKey === "pageId" || columnKey === "target" && row["type"] === "page") return this.configRowIds("pages");
    if (columnKey === "target" && row["type"] === "function") return this.configRowIds("functions");
    return undefined;
  }

  /** Shows a readable instance name while preserving its stable ID as the saved dropdown value. */
  tableColumnOptionLabel(field: PluginConfigField, columnKey: string, option: string): string {
    if (field.columns?.find((column) => column.key === columnKey)?.optionSource !== "plugin-instances") return option;
    const instance = this.manager.config().pluginInstances.find((candidate) => candidate.id === option);
    return instance?.name ?? `Unavailable instance (${option})`;
  }

  /** Updates a single cell in a schema-defined table and serializes the rows. */
  setTableCell(field: PluginConfigField, rowIndex: number, columnKey: string, value: unknown): void {
    const rows = this.tableRows(field).map((row) => ({ ...row }));
    if (!rows[rowIndex] || !field.columns?.some((column) => column.key === columnKey)) return;
    rows[rowIndex][columnKey] = typeof value === "string" ? value : "";
    const checkKey = this.scriptCheckKey(field, rowIndex, columnKey);
    this.scriptChecks.update((checks) => {
      const next = { ...checks };
      delete next[checkKey];
      return next;
    });
    this.setConfigValue(field, JSON.stringify(rows));
  }

  /** Identifies configured JavaScript bodies in schema-defined tables. */
  isScriptColumn(field: PluginConfigField, columnKey: string): boolean {
    return field.key === "pages" && columnKey === "renderCode" || field.key === "functions" && columnKey === "code";
  }

  /** Identifies standalone JavaScript settings that need an editor and syntax check. */
  isScriptField(field: PluginConfigField): boolean { return field.key === "startupCode"; }

  /** Returns startup-script syntax feedback only while it matches the current draft. */
  scriptFieldCheckState(field: PluginConfigField): ScriptCheckState | undefined {
    if (!this.isScriptField(field)) return undefined;
    const source = typeof this.instanceConfig()[field.key] === "string" ? this.instanceConfig()[field.key] as string : "";
    const check = this.scriptChecks()[this.scriptFieldCheckKey(field)];
    return check?.source === source ? check : undefined;
  }

  /** Checks a standalone plugin startup function without executing it. */
  checkScriptField(field: PluginConfigField): void {
    if (!this.isScriptField(field)) return;
    const source = typeof this.instanceConfig()[field.key] === "string" ? this.instanceConfig()[field.key] as string : "";
    this.checkScriptSource(source, this.scriptFieldCheckKey(field), () =>
      typeof this.instanceConfig()[field.key] === "string" ? this.instanceConfig()[field.key] as string : ""
    );
  }

  /** Counts compact columns so a multiline editor row can span the table. */
  tableVisibleColumnCount(field: PluginConfigField): number {
    return (field.columns ?? []).filter((column) => !column.multiline).length;
  }

  /** Reports whether a schema table needs an expanded editor row. */
  hasMultilineColumns(field: PluginConfigField): boolean {
    return (field.columns ?? []).some((column) => column.multiline);
  }

  /** Returns the syntax result only while it matches the row's current source. */
  scriptCheckState(field: PluginConfigField, rowIndex: number, columnKey: string): ScriptCheckState | undefined {
    if (!this.isScriptColumn(field, columnKey)) return undefined;
    const source = this.tableRows(field)[rowIndex]?.[columnKey] ?? "";
    const check = this.scriptChecks()[this.scriptCheckKey(field, rowIndex, columnKey)];
    return check?.source === source ? check : undefined;
  }

  /** Checks a page renderer or named function without running its code. */
  checkScript(field: PluginConfigField, rowIndex: number, columnKey: string): void {
    const source = this.tableRows(field)[rowIndex]?.[columnKey] ?? "";
    const key = this.scriptCheckKey(field, rowIndex, columnKey);
    this.checkScriptSource(source, key, () => this.tableRows(field)[rowIndex]?.[columnKey] ?? "");
  }

  /** Sends a script body to the API parser and ignores stale responses after edits. */
  private checkScriptSource(source: string, key: string, getCurrentSource: () => string): void {
    if (!source.trim()) {
      this.scriptChecks.update((checks) => ({ ...checks, [key]: { source, status: "invalid", message: "Enter a function body first." } }));
      return;
    }
    this.scriptChecks.update((checks) => ({ ...checks, [key]: { source, status: "checking", message: "Checking syntax…" } }));
    this.manager.checkPluginScript(source, this.instanceVariables()).subscribe({
      next: (result) => {
        const currentSource = getCurrentSource();
        if (currentSource !== source) return;
        this.scriptChecks.update((checks) => ({
          ...checks,
          [key]: { source, status: result.valid ? "valid" : "invalid", message: result.valid ? "Valid JavaScript." : result.error ?? "Invalid JavaScript." }
        }));
      },
      error: (error) => {
        const currentSource = getCurrentSource();
        if (currentSource !== source) return;
        this.scriptChecks.update((checks) => ({
          ...checks,
          [key]: { source, status: "invalid", message: error.error?.error || "Could not check JavaScript syntax." }
        }));
      }
    });
  }

  /** Adds a blank row unless the plugin schema's maximum has been reached. */
  addTableRow(field: PluginConfigField): void {
    const rows = this.tableRows(field);
    if (rows.length >= (field.maxRows ?? 8)) return;
    rows.push(Object.fromEntries((field.columns ?? []).map((column) => [column.key, ""])));
    this.setConfigValue(field, JSON.stringify(rows));
    if (field.rowCountKey) {
      const countField = this.selectedDefinition?.configSchema.find((candidate) => candidate.key === field.rowCountKey);
      if (countField) this.setConfigValue(countField, rows.length);
    }
  }

  /** Removes a table row while preserving its configured minimum row count. */
  removeTableRow(field: PluginConfigField, rowIndex: number): void {
    const rows = this.tableRows(field);
    if (rows.length <= (field.minRows ?? 0) || rowIndex < 0 || rowIndex >= rows.length) return;
    rows.splice(rowIndex, 1);
    this.setConfigValue(field, JSON.stringify(rows));
    if (field.rowCountKey) {
      const countField = this.selectedDefinition?.configSchema.find((candidate) => candidate.key === field.rowCountKey);
      if (countField) this.setConfigValue(countField, rows.length);
    }
  }

  /** Saves a reusable plugin definition or updates the selected definition. */
  savePluginProfile(): void {
    const draft: PluginProfileDraft = {
      name: this.profileName().trim(),
      pluginId: this.selectedPluginId(),
      config: this.instanceConfig()
    };
    this.savingProfile.set(true);
    const save = this.editingProfileId()
      ? this.manager.savePluginProfile({ ...draft, id: this.editingProfileId()! })
      : this.manager.addPluginProfile(draft);
    save.subscribe({
      next: ({ profile }) => {
        this.savingProfile.set(false);
        this.editingProfileId.set(profile.id);
        this.profileName.set(profile.name);
        if (!this.selectedPluginProfileId()) this.selectedPluginProfileId.set(profile.id);
        this.selectedPluginId.set(profile.pluginId);
        this.instanceConfig.set(structuredClone(profile.config));
        this.scriptChecks.set({});
        this.syncPreviewDefaults(profile.config);
        this.clearPagePreview();
        this.manager.inform("Plugin saved. Instances using it will use the updated configuration.");
      },
      error: (error) => {
        this.savingProfile.set(false);
        this.manager.inform(error.error?.error || "Could not save plugin.", "error");
      }
    });
  }

  /** Loads a reusable plugin definition into its editor. */
  editPluginProfile(profile: PluginProfile): void {
    this.editingProfileId.set(profile.id);
    this.profileName.set(profile.name);
    this.selectPlugin(profile.pluginId);
    this.editingProfileId.set(profile.id);
    const config = {
      ...Object.fromEntries((this.selectedDefinition?.configSchema ?? []).map((field) => [field.key, field.defaultValue])),
      ...structuredClone(profile.config)
    };
    this.instanceConfig.set(config);
    this.syncPreviewDefaults(config);
  }

  /** Returns the profile editor to a clean draft for a new plugin. */
  cancelProfileEdit(): void {
    this.editingProfileId.set(null);
    this.profileName.set("");
    this.selectPlugin(this.definitions()[0]?.id ?? "");
  }

  /** Removes a plugin definition when the API confirms it has no instances. */
  removePluginProfile(profile: PluginProfile): void {
    this.manager.removePluginProfile(profile).subscribe({
      next: () => {
        if (this.editingProfileId() === profile.id) this.cancelProfileEdit();
        if (this.selectedPluginProfileId() === profile.id) this.selectedPluginProfileId.set("");
        this.manager.inform("Plugin removed.");
      },
      error: (error) => this.manager.inform(error.error?.error || "Could not remove plugin.", "error")
    });
  }

  /** Saves an instance reference with its own name and variable values. */
  saveInstance(): void {
    const draft: PluginInstanceDraft = {
      name: this.instanceName().trim(),
      pluginProfileId: this.selectedPluginProfileId(),
      enabled: true,
      variables: { ...this.instanceVariables() }
    };
    this.savingInstance.set(true);
    const save = this.editingInstanceId()
      ? this.manager.savePluginInstance({ ...draft, id: this.editingInstanceId()! })
      : this.manager.addPluginInstance(draft);
    save.subscribe({
      next: ({ instance }) => {
        this.savingInstance.set(false);
        this.editingInstanceId.set(instance.id);
        this.instanceName.set(instance.name);
        this.selectedPluginProfileId.set(instance.pluginProfileId);
        this.instanceVariables.set(this.withProfileVariableDefaults(instance.pluginProfileId, instance.variables ?? {}));
        this.clearPagePreview();
        this.manager.inform("Plugin instance saved.");
      },
      error: (error) => {
        this.savingInstance.set(false);
        this.manager.inform(error.error?.error || "Could not save plugin instance.", "error");
      }
    });
  }

  /** Loads a saved device instance and its profile reference into the instance editor. */
  editInstance(instance: PluginInstance): void {
    this.editingInstanceId.set(instance.id);
    this.instanceName.set(instance.name);
    this.selectedPluginProfileId.set(instance.pluginProfileId);
    this.instanceVariables.set(this.withProfileVariableDefaults(instance.pluginProfileId, instance.variables ?? {}));
    this.clearPagePreview();
  }

  /** Starts a fresh instance draft without changing the reusable plugin editor. */
  cancelEdit(): void {
    this.editingInstanceId.set(null);
    this.instanceName.set("");
    this.instanceVariables.set({});
  }

  /** Selects a reusable plugin for the instance draft. */
  setInstanceProfile(pluginProfileId: string): void {
    this.selectedPluginProfileId.set(pluginProfileId);
    this.instanceVariables.set(this.withProfileVariableDefaults(pluginProfileId, this.instanceVariables()));
    this.clearPagePreview();
  }

  /** Removes an unused or retired plugin instance and its attached bindings. */
  removeInstance(instance: PluginInstance): void {
    this.manager.removePluginInstance(instance).subscribe({
      next: () => this.manager.inform("Plugin instance removed."),
      error: (error) => this.manager.inform(error.error?.error || "Could not remove plugin instance.", "error")
    });
  }

  /** Returns the per-instance variable map as rows for the simple key/value editor. */
  variableEntries(): Array<{ name: string; value: string }> {
    return Object.entries(this.instanceVariables()).map(([name, value]) => ({ name, value }));
  }

  /** Adds the next available variable name to this instance draft. */
  addVariable(): void {
    const variables = this.instanceVariables();
    let suffix = Object.keys(variables).length + 1;
    let name = `variable${suffix}`;
    while (Object.hasOwn(variables, name)) name = `variable${++suffix}`;
    this.instanceVariables.set({ ...variables, [name]: "" });
    this.clearPagePreview();
  }

  /** Renames one configured variable while keeping its value with the row. */
  setVariableName(index: number, name: string): void {
    const entries = Object.entries(this.instanceVariables());
    if (!entries[index] || entries.some(([existing], rowIndex) => rowIndex !== index && existing === name)) return;
    if (this.isFixedVariable(entries[index][0])) return;
    entries[index] = [name, entries[index][1]];
    this.instanceVariables.set(Object.fromEntries(entries));
    this.clearPagePreview();
  }

  /** Updates one variable's text value and invalidates any page preview. */
  setVariableValue(name: string, value: string): void {
    if (!Object.hasOwn(this.instanceVariables(), name)) return;
    this.instanceVariables.update((variables) => ({ ...variables, [name]: value }));
    this.clearPagePreview();
  }

  /** Removes one value from this instance's variable map. */
  removeVariable(name: string): void {
    if (this.isFixedVariable(name)) return;
    this.instanceVariables.update((variables) => {
      const next = { ...variables };
      delete next[name];
      return next;
    });
    this.clearPagePreview();
  }

  /** Validates the bounded variable map before enabling an instance save. */
  variablesValid(): boolean {
    const entries = Object.entries(this.instanceVariables());
    const validEntries = entries.length <= 64 && entries.every(([name, value]) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) && value.length <= 4096);
    return validEntries && !this.hasMissingRequiredVariables();
  }

  /** Checks required values declared by the selected plugin instance schema. */
  hasMissingRequiredVariables(): boolean {
    const requiredFields = this.selectedProfileDefinition?.instanceVariableFields?.filter((field) => field.required) ?? [];
    return requiredFields.some((field) => !this.instanceVariables()[field.key]?.trim());
  }

  /** Shows guidance for the currently selected plugin's instance-specific settings. */
  instanceVariableHelp(): string {
    if (this.selectedProfileDefinition?.instanceVariableFields?.length) return "Configure the fields required by this plugin. Additional variables remain available for templates and scripts.";
    const profile = this.manager.config().pluginProfiles.find((item) => item.id === this.selectedPluginProfileId());
    if (profile?.pluginId === "open-meteo-weather") {
      return "Add latitude and longitude for this location. Optionally add timezone (for example Europe/Berlin); leave it blank to use automatic timezone detection.";
    }
    if (profile?.pluginId === "mqtt-thermostat") {
      return "These values belong to this thermostat. For the default Homematic topics, add channel (for example LEQ0999385:2).";
    }
    return "These values belong to this device. Use {{name}} in scripts and MQTT actions, or read variables.name in JavaScript.";
  }

  /** Returns metadata for the selected reusable profile's instance variables. */
  variableField(name: string) {
    return this.selectedProfileDefinition?.instanceVariableFields?.find((field) => field.key === name);
  }

  /** Uses the plugin's descriptive label for built-in fields and a generic label for custom values. */
  variableLabel(name: string): string { return this.variableField(name)?.label ?? "Variable name"; }

  /** Returns concise field guidance from the plugin schema. */
  variableHelp(name: string): string { return this.variableField(name)?.help ?? ""; }

  /** Reports whether a variable name is defined by the plugin and must stay fixed. */
  isFixedVariable(name: string): boolean { return Boolean(this.variableField(name)); }

  /** Resolves plugin metadata for a saved instance row. */
  pluginName(pluginId: string): string { return this.definitions().find((item) => item.id === pluginId)?.name ?? pluginId; }
  /** Resolves the reusable plugin name referenced by one device instance. */
  instancePluginName(instance: PluginInstance): string {
    return this.manager.config().pluginProfiles.find((profile) => profile.id === instance.pluginProfileId)?.name ?? "Removed plugin";
  }
  /** Returns a compact view of the configured incoming topic for an instance. */
  primaryTopic(instance: PluginInstance): string {
    const profile = this.manager.config().pluginProfiles.find((candidate) => candidate.id === instance.pluginProfileId);
    if (profile?.pluginId === "mqtt-sonos-player") {
      return `sonos/${instance.variables.playerName || "<playerName>"}/state · ID ${instance.variables.playerId || "?"}`;
    }
    const value = profile?.config["topicFilters"] ?? profile?.config["stateTopic"];
    return typeof value === "string" ? value.split(/\r?\n/)[0] || "Configured plugin" : "Configured plugin";
  }

  /** Reports whether the selected generic plugin supports JavaScript page preview. */
  get canPreviewPage(): boolean { return this.selectedDefinition?.id === SCRIPTED_PLUGIN_ID; }

  /** Resolves the plugin definition for the currently selected saved instance profile. */
  private get selectedProfileDefinition(): PluginDefinition | undefined {
    const profile = this.manager.config().pluginProfiles.find((item) => item.id === this.selectedPluginProfileId());
    return this.definitions().find((definition) => definition.id === profile?.pluginId);
  }

  /** Adds blank values for schema-defined instance fields while retaining saved custom variables. */
  private withProfileVariableDefaults(pluginProfileId: string, variables: Record<string, string>): Record<string, string> {
    const profile = this.manager.config().pluginProfiles.find((item) => item.id === pluginProfileId);
    const definition = this.definitions().find((item) => item.id === profile?.pluginId);
    return Object.fromEntries([
      ...Object.entries(variables),
      ...(definition?.instanceVariableFields ?? [])
        .filter((field) => !Object.hasOwn(variables, field.key))
        .map((field) => [field.key, ""] as const)
    ]);
  }

  /** Returns configured pages for the preview selector, omitting unfinished rows. */
  previewPages(): Array<{ id: string; name: string }> {
    const field = this.selectedDefinition?.configSchema.find((candidate) => candidate.key === "pages");
    if (!field) return [];
    return this.tableRows(field)
      .filter((row) => Boolean(row["id"]?.trim()))
      .map((row) => ({ id: row["id"], name: row["name"] || row["id"] }));
  }

  /** Updates the preview page selection and clears a result from the previous input. */
  setPreviewPageId(pageId: string): void { this.previewPageId.set(pageId); this.clearPagePreview(); }
  /** Updates the sample incoming topic used by the preview request. */
  setPreviewTopic(topic: string): void { this.previewTopic.set(topic); this.clearPagePreview(); }
  /** Updates the sample incoming payload used by the preview request. */
  setPreviewPayload(payload: string): void { this.previewPayload.set(payload); this.clearPagePreview(); }

  /** Runs the selected unsaved page renderer with a sample MQTT envelope. */
  previewPage(): void {
    const definition = this.selectedDefinition;
    if (!definition || !this.previewTopic().trim() || !this.previewPageId()) return;
    this.previewingPage.set(true);
    this.pagePreview.set(null);
    this.pagePreviewError.set("");
    this.manager.previewPluginPage({
      pluginId: definition.id,
      config: structuredClone(this.instanceConfig()),
      variables: { ...this.instanceVariables() },
      pageId: this.previewPageId(),
      topic: this.previewTopic().trim(),
      payload: this.previewPayload()
    }).subscribe({
      next: (result) => { this.pagePreview.set(result); this.previewingPage.set(false); },
      error: (error) => {
        this.pagePreviewError.set(error.error?.error || "Could not render this page preview.");
        this.previewingPage.set(false);
      }
    });
  }

  /** Parses string-backed table data and fills missing cells with empty strings. */
  private parseTableRows(value: PluginConfigValue | undefined, field: PluginConfigField): Record<string, string>[] {
    if (typeof value !== "string" || !field.columns?.length) return [];
    try {
      const parsed: unknown = JSON.parse(value);
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap((row: unknown) => {
        if (!row || typeof row !== "object" || Array.isArray(row)) return [];
        const source = row as Record<string, unknown>;
        return [Object.fromEntries(field.columns!.map((column) => [
          column.key,
          typeof source[column.key] === "string" ? source[column.key] as string : ""
        ]))];
      });
    } catch {
      return [];
    }
  }

  /** Returns non-empty IDs from another schema table for linked selectors. */
  private configRowIds(key: string): string[] {
    const field = this.selectedDefinition?.configSchema.find((candidate) => candidate.key === key);
    return field ? this.tableRows(field).map((row) => row["id"]).filter(Boolean) : [];
  }

  /** Rewrites start-page and button references after a page ID is renamed. */
  private renamePageReferences(previousId: string, nextId: string): void {
    const startPageField = this.selectedDefinition?.configSchema.find((field) => field.key === "startPage");
    if (startPageField && this.instanceConfig()["startPage"] === previousId) this.setConfigValue(startPageField, nextId);
    if (this.previewPageId() === previousId) this.previewPageId.set(nextId);

    const actionsField = this.buttonActionsField();
    if (!actionsField) return;
    const actions = this.tableRows(actionsField).map((action) => ({ ...action }));
    let changed = false;
    for (const action of actions) {
      if (action["pageId"] === previousId) {
        action["pageId"] = nextId;
        changed = true;
      }
      if (action["type"] === "page" && action["target"] === previousId) {
        action["target"] = nextId;
        changed = true;
      }
    }
    if (changed) this.setConfigValue(actionsField, JSON.stringify(actions));
  }

  /** Rewrites function-button targets after a helper ID is renamed. */
  private renameFunctionReferences(previousId: string, nextId: string): void {
    const actionsField = this.buttonActionsField();
    if (!actionsField) return;
    const actions = this.tableRows(actionsField).map((action) => ({ ...action }));
    let changed = false;
    for (const action of actions) {
      if (action["type"] === "function" && action["target"] === previousId) {
        action["target"] = nextId;
        changed = true;
      }
    }
    if (changed) this.setConfigValue(actionsField, JSON.stringify(actions));
  }

  /** Sets a useful initial sample from the selected plugin's start page and topic filter. */
  private syncPreviewDefaults(config: Record<string, PluginConfigValue>): void {
    if (typeof config["startPage"] === "string") this.previewPageId.set(config["startPage"]);
    if (typeof config["topicFilters"] === "string") {
      this.previewTopic.set(config["topicFilters"].split(/\r?\n/).map((topic) => topic.trim()).find(Boolean) ?? "");
    }
  }

  /** Clears stale preview output when its source configuration or sample changes. */
  private clearPagePreview(): void {
    this.pagePreview.set(null);
    this.pagePreviewError.set("");
  }

  /** Produces a stable key for a standalone JavaScript setting's syntax feedback. */
  private scriptFieldCheckKey(field: PluginConfigField): string { return field.key + ":source"; }

  /** Produces a stable per-cell key for the editor's syntax feedback. */
  private scriptCheckKey(field: PluginConfigField, rowIndex: number, columnKey: string): string {
    return `${field.key}:${rowIndex}:${columnKey}`;
  }

  /** Resizes a table to a linked numeric setting without discarding retained rows. */
  private resizeTableRows(value: PluginConfigValue | undefined, field: PluginConfigField, count: number): Record<string, string>[] {
    const rows = this.parseTableRows(value, field).slice(0, count);
    while (rows.length < count) {
      const index = rows.length;
      rows.push(Object.fromEntries((field.columns ?? []).map((column) => [
        column.key,
        column.key === "label" ? `Speed ${index + 1}` : ""
      ])));
    }
    return rows;
  }
}
