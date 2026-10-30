import { Component, ElementRef, OnInit, effect, input, signal, viewChild } from "@angular/core";
import { DatePipe } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { TranslatePipe } from "@ngx-translate/core";
import { ManagerStore } from "../../manager-store.service";
import type { HomeAssistantAreaOption, HomeAssistantEntityOption, PluginBlueprintPreview, PluginConfigField, PluginConfigValue, PluginDefinition, PluginInstance, PluginInstanceDraft, PluginPagePreviewResult, PluginProfile, PluginProfileDraft } from "../../models";
import { ScriptEditorComponent } from "./script-editor.component";
import { PanelScreenPreviewComponent } from "../panels/panel-screen-preview.component";

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

interface TableRowSettingsSelection {
  fieldKey: string;
  rowIndex: number;
}

interface PluginInstanceGroup {
  id: string;
  name: string;
  pluginTypeName: string;
  instances: PluginInstance[];
}

interface HomeAssistantEntityGroup {
  label: string;
  entities: HomeAssistantEntityOption[];
}

/**
 * Configures reusable plugin profiles and per-device instances. Registry
 * schemas drive the profile editor; panel favorite bindings live with panels.
 */
@Component({
  selector: "nspanel-plugins-page",
  standalone: true,
  imports: [DatePipe, FormsModule, ScriptEditorComponent, PanelScreenPreviewComponent, TranslatePipe],
  templateUrl: "./plugins-page.component.html",
  styleUrl: "./plugins-page.component.css"
})
export class PluginsPageComponent implements OnInit {
  readonly screen = input<"plugins" | "instances">("plugins");
  readonly definitions = signal<PluginDefinition[]>([]);
  readonly selectedPluginId = signal("");
  readonly profileName = signal("");
  readonly editingProfileId = signal<string | null>(null);
  readonly editingProfileConfiguredSecrets = signal<string[]>([]);
  readonly activePageIndex = signal(0);
  readonly activeFunctionIndex = signal(0);
  readonly expandedButtonPageIndexes = signal<Set<number>>(new Set());
  readonly selectedPluginProfileId = signal("");
  readonly instanceName = signal("");
  readonly instanceConfig = signal<Record<string, PluginConfigValue>>({});
  readonly instanceVariables = signal<Record<string, string>>({});
  readonly homeAssistantEntities = signal<Record<string, HomeAssistantEntityOption[]>>({});
  readonly homeAssistantAreas = signal<Record<string, HomeAssistantAreaOption[]>>({});
  readonly homeAssistantAreasAvailable = signal<Record<string, boolean>>({});
  readonly loadingHomeAssistantProfileId = signal("");
  readonly homeAssistantEntityErrors = signal<Record<string, string>>({});
  readonly homeAssistantEntitySearch = signal("");
  readonly homeAssistantEntityTypeFilter = signal("all");
  readonly homeAssistantAreaFilter = signal("all");
  readonly editingInstanceId = signal<string | null>(null);
  readonly mobileInstanceEditorOpen = signal(false);
  readonly instanceSearch = signal("");
  readonly expandedInstanceGroups = signal<Set<string>>(new Set());
  readonly collapsedSearchInstanceGroups = signal<Set<string>>(new Set());
  readonly previewPageId = signal("overview");
  readonly previewTopic = signal("home/device/state");
  readonly previewPayload = signal("{}");
  readonly previewingPage = signal(false);
  readonly pagePreview = signal<PluginPagePreviewResult | null>(null);
  readonly pagePreviewError = signal("");
  readonly pagePreviewNotice = signal("");
  readonly previewHistory = signal<string[]>([]);
  readonly scriptChecks = signal<Record<string, ScriptCheckState>>({});
  readonly rowSettingsSelection = signal<TableRowSettingsSelection | null>(null);
  readonly rowSettingsDialog = viewChild<ElementRef<HTMLDialogElement>>("rowSettingsDialog");
  readonly savingInstance = signal(false);
  readonly savingProfile = signal(false);
  readonly blueprintExportInstanceId = signal("");
  readonly blueprintPreview = signal<PluginBlueprintPreview | null>(null);
  readonly blueprintSource = signal<unknown>(null);
  readonly blueprintProfileName = signal("");
  readonly blueprintInstanceName = signal("");
  readonly blueprintIncludeInstance = signal(false);
  readonly blueprintFileName = signal("");
  readonly blueprintError = signal("");
  readonly blueprintNotice = signal("");
  readonly previewingBlueprint = signal(false);
  readonly importingBlueprint = signal(false);
  readonly instanceSortBy = signal<"name" | "panel">("name");
  readonly buttonSlots = Array.from({ length: 8 }, (_, index) => String(index + 1));

  /** Provides shared configuration and typed API operations for this page. */
  constructor(readonly manager: ManagerStore) {
    effect(() => {
      const dialog = this.rowSettingsDialog()?.nativeElement;
      const selection = this.rowSettingsSelection();
      if (!dialog) return;
      if (selection && !dialog.open) dialog.showModal();
      if (!selection && dialog.open) dialog.close();
    });
  }

  /** Loads plugin schemas and the saved instance and binding lists. */
  ngOnInit(): void { this.refresh(); }

  /** Refreshes saved configuration and obtains the schemas for dynamic forms. */
  refresh(): void {
    this.manager.refresh().subscribe({
      next: () => {
        const firstProfile = this.manager.config().pluginProfiles[0];
        if (!this.selectedPluginProfileId() && firstProfile) this.setInstanceProfile(firstProfile.id);
      },
      error: () => this.manager.inform("PLUGINS.ERROR_LOAD_CONFIGURATION", "error")
    });
    this.manager.loadPlugins().subscribe({
      next: ({ plugins }) => {
        this.definitions.set(plugins);
        if (this.selectedPluginProfileId()) this.setInstanceProfile(this.selectedPluginProfileId());
        if (!plugins.some((plugin) => plugin.id === this.selectedPluginId())) this.selectPlugin(plugins[0]?.id ?? "");
      },
      error: () => this.manager.inform("PLUGINS.ERROR_LOAD_REGISTRY", "error")
    });
  }

  /** Returns the schema currently selected for a new or edited reusable plugin. */
  get selectedDefinition(): PluginDefinition | undefined {
    return this.definitions().find((definition) => definition.id === this.selectedPluginId());
  }

  /** Returns the device instances that can be included as a profile template. */
  currentProfileInstances(): PluginInstance[] {
    const profileId = this.editingProfileId();
    return profileId ? this.manager.config().pluginInstances.filter((instance) => instance.pluginProfileId === profileId) : [];
  }

  /** Downloads the selected profile as a portable blueprint without secret values. */
  exportPluginBlueprint(): void {
    const profileId = this.editingProfileId();
    if (!profileId) return;
    const instanceId = this.blueprintExportInstanceId() || undefined;
    this.manager.downloadPluginBlueprint(profileId, instanceId).subscribe({
      next: (file) => {
        const profile = this.manager.config().pluginProfiles.find((item) => item.id === profileId);
        const safeName = (profile?.name ?? "plugin").normalize("NFKD").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "plugin";
        const objectUrl = URL.createObjectURL(file);
        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = `${safeName}.nspanel-plugin.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(objectUrl);
        this.blueprintError.set("");
      },
      error: (error) => this.blueprintError.set(error.error?.error || "PLUGINS.BLUEPRINT_EXPORT_ERROR")
    });
  }

  /** Reads a selected JSON file and asks the API to validate it before import. */
  async selectBlueprintFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    this.blueprintPreview.set(null);
    this.blueprintSource.set(null);
    this.blueprintNotice.set("");
    this.blueprintError.set("");
    this.blueprintFileName.set(file?.name ?? "");
    if (!file) return;
    this.previewingBlueprint.set(true);
    try {
      const blueprint: unknown = JSON.parse(await file.text());
      this.blueprintSource.set(blueprint);
      this.manager.previewPluginBlueprint(blueprint).subscribe({
        next: (preview) => {
          this.blueprintPreview.set(preview);
          this.blueprintProfileName.set(preview.profileName);
          this.blueprintInstanceName.set(preview.instanceName);
          this.blueprintIncludeInstance.set(preview.hasInstanceTemplate);
          this.previewingBlueprint.set(false);
        },
        error: (error) => {
          this.blueprintError.set(error.error?.error || "PLUGINS.BLUEPRINT_PREVIEW_ERROR");
          this.previewingBlueprint.set(false);
        }
      });
    } catch {
      this.blueprintError.set("PLUGINS.BLUEPRINT_INVALID_JSON");
      this.previewingBlueprint.set(false);
    }
  }

  /** Imports the profile and optional instance together as one API transaction. */
  importPluginBlueprint(): void {
    const preview = this.blueprintPreview();
    const blueprint = this.blueprintSource();
    if (!preview || blueprint === null || this.isBlueprintImportDisabled()) return;
    this.importingBlueprint.set(true);
    this.blueprintError.set("");
    this.manager.importPluginBlueprint({
      blueprint,
      profileName: this.blueprintProfileName().trim(),
      includeInstance: this.blueprintIncludeInstance(),
      instanceName: this.blueprintInstanceName().trim()
    }).subscribe({
      next: ({ profile, instance, warnings }) => {
        this.importingBlueprint.set(false);
        this.editPluginProfile(profile);
        if (instance) this.selectedPluginProfileId.set(profile.id);
        this.blueprintNotice.set(warnings.length > 0 ? warnings.join(" ") : "PLUGINS.BLUEPRINT_IMPORT_SUCCESS");
        this.blueprintPreview.set(null);
        this.blueprintSource.set(null);
        this.blueprintFileName.set("");
      },
      error: (error) => {
        this.importingBlueprint.set(false);
        this.blueprintError.set(error.error?.error || "PLUGINS.BLUEPRINT_IMPORT_ERROR");
      }
    });
  }

  /** Prevents an incomplete or conflicting preview from reaching the import endpoint. */
  isBlueprintImportDisabled(): boolean {
    const preview = this.blueprintPreview();
    if (!preview || this.importingBlueprint() || !this.blueprintProfileName().trim()) return true;
    if (this.blueprintProfileNameConflict()) return true;
    if (!this.blueprintIncludeInstance()) return false;
    if (!preview.hasInstanceTemplate || !this.blueprintInstanceName().trim()) return true;
    if (this.blueprintInstanceNameConflict()) return true;
    const definition = this.definitions().find((plugin) => plugin.id === preview.pluginId);
    return (definition?.instanceVariableFields ?? []).some((field) => field.required &&
      preview.warnings.includes(`Instance template needs a value for '${field.label}'.`));
  }

  /** Checks the editable import name against the profiles currently saved in this manager. */
  blueprintProfileNameConflict(): boolean {
    const name = this.blueprintProfileName().trim().toLocaleLowerCase();
    return Boolean(name) && this.manager.config().pluginProfiles.some((profile) =>
      profile.name.trim().toLocaleLowerCase() === name);
  }

  /** Checks the editable instance name against instances of the imported plugin. */
  blueprintInstanceNameConflict(): boolean {
    const preview = this.blueprintPreview();
    const name = this.blueprintInstanceName().trim().toLocaleLowerCase();
    return Boolean(preview && name) && this.manager.config().pluginInstances.some((instance) => {
      const profile = this.manager.config().pluginProfiles.find((candidate) => candidate.id === instance.pluginProfileId);
      return profile?.pluginId === preview?.pluginId && instance.name.trim().toLocaleLowerCase() === name;
    });
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
    } else if (field.type === "checkbox") {
      normalized = typeof value === "boolean" ? value : false;
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

  /** Opens the settings dialog for one row in a schema-defined table. */
  openRowSettings(field: PluginConfigField, rowIndex: number): void {
    if (!this.tableRows(field)[rowIndex] || !this.hasRowSettingsColumns(field)) return;
    this.rowSettingsSelection.set({ fieldKey: field.key, rowIndex });
  }

  /** Clears the selected row so the dialog closes and releases its modal focus trap. */
  closeRowSettings(): void {
    this.rowSettingsSelection.set(null);
  }

  /** Closes the dialog only when the user clicks its backdrop. */
  closeRowSettingsOnBackdrop(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.closeRowSettings();
  }

  /** Returns the active dialog row only for the table currently being rendered. */
  rowSettingsForField(field: PluginConfigField): TableRowSettingsSelection | null {
    const selection = this.rowSettingsSelection();
    return selection?.fieldKey === field.key && this.tableRows(field)[selection.rowIndex]
      ? selection
      : null;
  }

  /** Reports whether a table defines columns that belong in its row-settings dialog. */
  hasRowSettingsColumns(field: PluginConfigField): boolean {
    return (field.columns ?? []).some((column) => column.editInDialog);
  }

  /** Returns the row-settings columns in the schema's display order. */
  rowSettingsColumns(field: PluginConfigField): NonNullable<PluginConfigField["columns"]> {
    return (field.columns ?? []).filter((column) => column.editInDialog);
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
  isScriptField(field: PluginConfigField): boolean {
    return field.key === "startupCode" || field.key === "buttonPressCode" || field.key === "groupMessageCode";
  }

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
    return (field.columns ?? []).filter((column) => !column.multiline && !column.editInDialog).length;
  }

  /** Reports whether a schema table needs an expanded editor row. */
  hasMultilineColumns(field: PluginConfigField): boolean {
    return (field.columns ?? []).some((column) => column.multiline && !column.editInDialog);
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
      this.scriptChecks.update((checks) => ({ ...checks, [key]: { source, status: "invalid", message: "PLUGINS.SCRIPT_BODY_REQUIRED" } }));
      return;
    }
    this.scriptChecks.update((checks) => ({ ...checks, [key]: { source, status: "checking", message: "PLUGINS.CHECKING" } }));
    this.manager.checkPluginScript(source, this.instanceVariables()).subscribe({
      next: (result) => {
        const currentSource = getCurrentSource();
        if (currentSource !== source) return;
        this.scriptChecks.update((checks) => ({
          ...checks,
          [key]: { source, status: result.valid ? "valid" : "invalid", message: result.valid ? "PLUGINS.VALID_JAVASCRIPT" : result.error ?? "PLUGINS.INVALID_JAVASCRIPT" }
        }));
      },
      error: (error) => {
        const currentSource = getCurrentSource();
        if (currentSource !== source) return;
        this.scriptChecks.update((checks) => ({
          ...checks,
          [key]: { source, status: "invalid", message: error.error?.error || "PLUGINS.ERROR_CHECK_SYNTAX" }
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

  /** Clears or removes a table row according to its schema while preserving minimum row counts. */
  removeTableRow(field: PluginConfigField, rowIndex: number): void {
    const rows = this.tableRows(field);
    if (rowIndex < 0 || rowIndex >= rows.length) return;
    if (field.removeRowBehavior === "clear") {
      rows[rowIndex] = Object.fromEntries((field.columns ?? []).map((column) => [column.key, ""]));
    } else {
      if (rows.length <= (field.minRows ?? 0)) return;
      rows.splice(rowIndex, 1);
    }
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
        this.editingProfileConfiguredSecrets.set(profile.configuredSecrets ?? []);
        this.scriptChecks.set({});
        this.syncPreviewDefaults(profile.config);
        this.clearPagePreview();
        this.manager.inform("PLUGINS.NOTICE_PROFILE_SAVED");
      },
      error: (error) => {
        this.savingProfile.set(false);
        this.manager.inform(error.error?.error || "PLUGINS.ERROR_SAVE_PLUGIN", "error");
      }
    });
  }

  /** Loads a reusable plugin definition into its editor. */
  editPluginProfile(profile: PluginProfile): void {
    this.blueprintExportInstanceId.set("");
    this.editingProfileId.set(profile.id);
    this.editingProfileConfiguredSecrets.set(profile.configuredSecrets ?? []);
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
    this.editingProfileConfiguredSecrets.set([]);
    this.profileName.set("");
    this.selectPlugin(this.definitions()[0]?.id ?? "");
  }

  /** Removes the profile currently shown in the editor after confirmation. */
  removeCurrentPluginProfile(): void {
    const profileId = this.editingProfileId();
    const profile = profileId ? this.manager.config().pluginProfiles.find((item) => item.id === profileId) : undefined;
    if (profile) this.removePluginProfile(profile);
  }

  /** Removes a plugin definition when the API confirms it has no instances. */
  removePluginProfile(profile: PluginProfile): void {
    if (!this.manager.confirm("PLUGINS.CONFIRM_REMOVE_PLUGIN", { name: profile.name })) return;
    this.manager.removePluginProfile(profile).subscribe({
      next: () => {
        if (this.editingProfileId() === profile.id) this.cancelProfileEdit();
        if (this.selectedPluginProfileId() === profile.id) this.selectedPluginProfileId.set("");
        this.manager.inform("PLUGINS.NOTICE_PLUGIN_REMOVED");
      },
      error: (error) => this.manager.inform(error.error?.error || "PLUGINS.ERROR_REMOVE_PLUGIN", "error")
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
        this.expandedInstanceGroups.update((expanded) => new Set(expanded).add(instance.pluginProfileId));
        this.collapsedSearchInstanceGroups.update((collapsed) => {
          const next = new Set(collapsed);
          next.delete(instance.pluginProfileId);
          return next;
        });
        this.instanceName.set(instance.name);
        this.selectedPluginProfileId.set(instance.pluginProfileId);
        this.instanceVariables.set(this.withProfileVariableDefaults(instance.pluginProfileId, instance.variables ?? {}));
        this.clearPagePreview();
        this.manager.inform("PLUGINS.NOTICE_INSTANCE_SAVED");
      },
      error: (error) => {
        this.savingInstance.set(false);
        this.manager.inform(error.error?.error || "PLUGINS.ERROR_SAVE_INSTANCE", "error");
      }
    });
  }

  /** Loads a saved device instance and its profile reference into the instance editor. */
  editInstance(instance: PluginInstance): void {
    this.mobileInstanceEditorOpen.set(true);
    this.editingInstanceId.set(instance.id);
    this.expandedInstanceGroups.update((expanded) => new Set(expanded).add(instance.pluginProfileId));
    this.collapsedSearchInstanceGroups.update((collapsed) => {
      const next = new Set(collapsed);
      next.delete(instance.pluginProfileId);
      return next;
    });
    this.instanceName.set(instance.name);
    this.selectedPluginProfileId.set(instance.pluginProfileId);
    // Start from this instance's variables plus schema defaults, never the previous editor's draft.
    this.instanceVariables.set(this.withProfileVariableDefaults(instance.pluginProfileId, instance.variables ?? {}));
    this.resetHomeAssistantEntityFilters();
    this.loadHomeAssistantEntitiesForProfile(instance.pluginProfileId);
    this.clearPagePreview();
  }

  /** Clears every field from the current instance before starting a fresh draft. */
  cancelEdit(): void {
    this.mobileInstanceEditorOpen.set(false);
    this.editingInstanceId.set(null);
    this.instanceName.set("");
    this.selectedPluginProfileId.set("");
    this.instanceVariables.set({});
    this.loadingHomeAssistantProfileId.set("");
    this.resetHomeAssistantEntityFilters();
    this.clearPagePreview();
  }

  /** Opens a clean instance draft from the mobile list view. */
  startNewInstance(): void {
    this.cancelEdit();
    this.mobileInstanceEditorOpen.set(true);
  }

  /** Returns to the instance list while preserving the current draft. */
  showInstanceList(): void {
    this.mobileInstanceEditorOpen.set(false);
  }

  /** Selects a reusable plugin for the instance draft. */
  setInstanceProfile(pluginProfileId: string): void {
    if (this.selectedPluginProfileId() !== pluginProfileId) this.resetHomeAssistantEntityFilters();
    this.selectedPluginProfileId.set(pluginProfileId);
    this.instanceVariables.set(this.withProfileVariableDefaults(pluginProfileId, this.instanceVariables()));
    this.loadHomeAssistantEntitiesForProfile(pluginProfileId);
    this.clearPagePreview();
  }

  /** Loads selectable entities from the saved Home Assistant connection profile. */
  loadHomeAssistantEntitiesForProfile(profileId: string): void {
    const profile = this.manager.config().pluginProfiles.find((item) => item.id === profileId);
    if (profile?.pluginId !== "home-assistant") return;
    this.loadingHomeAssistantProfileId.set(profileId);
    this.homeAssistantEntityErrors.update((errors) => ({ ...errors, [profileId]: "" }));
    this.manager.loadHomeAssistantEntities(profileId).subscribe({
      next: (result) => {
        const { entities } = result;
        // Keep results keyed by profile because several profiles may load while the editor is in use.
        this.homeAssistantEntities.update((current) => ({ ...current, [profileId]: entities }));
        this.homeAssistantAreas.update((current) => ({ ...current, [profileId]: result.areas ?? [] }));
        this.homeAssistantAreasAvailable.update((current) => ({ ...current, [profileId]: result.areasAvailable }));
        if (this.loadingHomeAssistantProfileId() === profileId) this.loadingHomeAssistantProfileId.set("");
      },
      error: (error) => {
        this.homeAssistantEntityErrors.update((errors) => ({ ...errors, [profileId]: error.error?.error || "Could not load Home Assistant entities." }));
        if (this.loadingHomeAssistantProfileId() === profileId) this.loadingHomeAssistantProfileId.set("");
      }
    });
  }

  /** Returns entity choices for the currently selected Home Assistant profile. */
  homeAssistantEntityOptions(): HomeAssistantEntityOption[] {
    return this.homeAssistantEntities()[this.selectedPluginProfileId()] ?? [];
  }

  /** Returns available entity domains for the current Home Assistant profile. */
  homeAssistantEntityTypeOptions(): Array<{ value: string; label: string }> {
    const domains = new Set(this.homeAssistantEntityOptions().map((entity) => entity.domain));
    return [...domains]
      .map((value) => ({ value, label: this.homeAssistantEntityDomainLabel(value) }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }

  /** Returns area choices reported by Home Assistant's registries. */
  homeAssistantAreaOptions(): Array<{ id: string; name: string }> {
    const areas = new Map<string, string>();
    for (const area of this.homeAssistantAreas()[this.selectedPluginProfileId()] ?? []) {
      areas.set(area.id, area.name);
    }
    // Preserve choices from cached entity metadata when talking to an older API build.
    for (const entity of this.homeAssistantEntityOptions()) {
      if (entity.areaId && entity.areaName) areas.set(entity.areaId, entity.areaName);
    }
    return [...areas.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  /** Filters entities by domain, area, and a search across their labels and IDs. */
  filteredHomeAssistantEntities(): HomeAssistantEntityOption[] {
    const query = this.homeAssistantEntitySearch().trim().toLocaleLowerCase();
    const entityType = this.homeAssistantEntityTypeFilter();
    const area = this.homeAssistantAreaFilter();
    return this.homeAssistantEntityOptions().filter((entity) => {
      if (entityType !== "all" && entity.domain !== entityType) return false;
      if (area === "no-area" && entity.areaId) return false;
      if (area !== "all" && area !== "no-area" && entity.areaId !== area) return false;
      if (!query) return true;
      return [entity.name, entity.entityId, entity.state, entity.areaName, this.homeAssistantEntityDomainLabel(entity.domain)]
        .some((value) => value?.toLocaleLowerCase().includes(query));
    });
  }

  /** Groups visible entity choices by area and type, retaining the current selection. */
  homeAssistantEntityGroups(selectedEntityId: string): HomeAssistantEntityGroup[] {
    const visible = this.filteredHomeAssistantEntities();
    const selected = this.homeAssistantEntityOptions().find((entity) => entity.entityId === selectedEntityId);
    const groups = new Map<string, HomeAssistantEntityGroup>();
    if (selected && !visible.some((entity) => entity.entityId === selected.entityId)) {
      groups.set("selected", { label: "Current selection", entities: [selected] });
    }
    for (const entity of visible) {
      const areaName = entity.areaName ?? this.manager.translateText("PLUGINS.NO_AREA");
      const typeName = this.homeAssistantEntityDomainLabel(entity.domain);
      const label = `${areaName} · ${typeName}`;
      const group = groups.get(label) ?? { label, entities: [] };
      group.entities.push(entity);
      groups.set(label, group);
    }
    return [...groups.values()];
  }

  /** Formats Home Assistant domains for the entity picker. */
  homeAssistantEntityDomainLabel(domain: string): string {
    const labels: Record<string, string> = {
      cover: "Covers and blinds",
      fan: "Fans",
      input_boolean: "Input booleans",
      light: "Lights",
      media_player: "Media players",
      switch: "Switches",
      vacuum: "Vacuum robots"
    };
    return labels[domain] ?? domain.replaceAll("_", " ");
  }

  /** Reports whether Home Assistant area metadata loaded for the selected profile. */
  homeAssistantAreaMetadataAvailable(): boolean {
    return this.homeAssistantAreasAvailable()[this.selectedPluginProfileId()] ?? false;
  }

  /** Resets picker filters when the selected profile or instance changes. */
  private resetHomeAssistantEntityFilters(): void {
    this.homeAssistantEntitySearch.set("");
    this.homeAssistantEntityTypeFilter.set("all");
    this.homeAssistantAreaFilter.set("all");
  }

  /** Reports whether the selected instance profile declares a Home Assistant entity picker. */
  hasHomeAssistantEntityField(): boolean {
    return this.instanceVariableFields().some((field) => field.optionSource === "home-assistant-entities");
  }

  /** Returns the current entity-list loading or connection error message. */
  homeAssistantEntityError(): string {
    return this.homeAssistantEntityErrors()[this.selectedPluginProfileId()] ?? "";
  }

  /** Removes an unused or retired plugin instance and its attached bindings. */
  removeInstance(instance: PluginInstance): void {
    this.manager.removePluginInstance(instance).subscribe({
      next: () => this.manager.inform("PLUGINS.NOTICE_INSTANCE_REMOVED"),
      error: (error) => this.manager.inform(error.error?.error || "PLUGINS.ERROR_REMOVE_INSTANCE", "error")
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

  /** Checks required values declared by the plugin or referenced by its topic settings. */
  hasMissingRequiredVariables(): boolean {
    return this.missingRequiredVariables().length > 0;
  }

  /** Names required variables that are missing from the current instance draft. */
  missingRequiredVariables(): string[] {
    return this.instanceVariableFields()
      .filter((field) => field.required && !this.instanceVariables()[field.key]?.trim())
      .map((field) => field.label || field.key);
  }

  /** Shows guidance for the currently selected plugin's instance-specific settings. */
  instanceVariableHelp(): string {
    if (this.instanceVariableFields().length) return this.manager.translateText("PLUGINS.INSTANCE_VARIABLE_HELP_REQUIRED");
    const profile = this.manager.config().pluginProfiles.find((item) => item.id === this.selectedPluginProfileId());
    if (profile?.pluginId === "open-meteo-weather") {
      return this.manager.translateText("PLUGINS.INSTANCE_VARIABLE_HELP_WEATHER");
    }
    if (profile?.pluginId === "mqtt-thermostat") {
      return this.manager.translateText("PLUGINS.INSTANCE_VARIABLE_HELP_THERMOSTAT");
    }
    return this.manager.translateText("PLUGINS.INSTANCE_VARIABLE_HELP_DEFAULT");
  }

  /** Returns metadata for the selected reusable profile's instance variables. */
  variableField(name: string) {
    return this.instanceVariableFields().find((field) => field.key === name);
  }

  /** Resolves declared fields and required variables referenced by profile topic templates. */
  instanceVariableFields(): NonNullable<PluginDefinition["instanceVariableFields"]> {
    return this.profileVariableFields(this.selectedPluginProfileId());
  }

  /** Uses the plugin's descriptive label for built-in fields and a generic label for custom values. */
  variableLabel(name: string): string { return this.variableField(name)?.label ?? this.manager.translateText("PLUGINS.VARIABLE_NAME"); }

  /** Returns concise field guidance from the plugin schema. */
  variableHelp(name: string): string { return this.variableField(name)?.help ?? ""; }

  /** Reports whether a variable name is defined by the plugin and must stay fixed. */
  isFixedVariable(name: string): boolean { return Boolean(this.variableField(name)); }

  /** Resolves plugin metadata for a saved instance row. */
  pluginName(pluginId: string): string { return this.definitions().find((item) => item.id === pluginId)?.name ?? pluginId; }
  /** Groups saved instances by reusable plugin profile and applies search and child sorting. */
  get instanceGroups(): PluginInstanceGroup[] {
    const groups = new Map<string, PluginInstanceGroup>();
    const query = this.instanceSearch().trim().toLocaleLowerCase();
    const instances = this.manager.config().pluginInstances;
    for (const instance of instances) {
      const profile = this.manager.config().pluginProfiles.find((candidate) => candidate.id === instance.pluginProfileId);
      const group = groups.get(instance.pluginProfileId) ?? {
        id: instance.pluginProfileId,
        name: profile?.name ?? this.manager.translateText("PLUGINS.REMOVED_PLUGIN"),
        pluginTypeName: profile ? this.pluginName(profile.pluginId) : "",
        instances: []
      };
      group.instances.push(instance);
      groups.set(instance.pluginProfileId, group);
    }
    const sortBy = this.instanceSortBy();
    return [...groups.values()].flatMap((group) => {
      const groupMatches = group.name.toLocaleLowerCase().includes(query) || group.pluginTypeName.toLocaleLowerCase().includes(query);
      const matchingInstances = group.instances.filter((instance) => {
        if (!query || groupMatches) return true;
        const searchable = [instance.name, this.primaryTopic(instance), ...this.panelNames(instance)].join(" ").toLocaleLowerCase();
        return searchable.includes(query);
      });
      if (!matchingInstances.length) return [];
      matchingInstances.sort((left, right) => {
        if (sortBy === "panel") {
          const leftPanels = this.panelNames(left);
          const rightPanels = this.panelNames(right);
          const comparison = Number(leftPanels.length === 0) - Number(rightPanels.length === 0)
            || leftPanels.join(", ").localeCompare(rightPanels.join(", "), undefined, { sensitivity: "base" });
          if (comparison) return comparison;
        }
        return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
      });
      return [{ ...group, instances: matchingInstances }];
    }).sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
  }
  /** Returns whether a plugin group is open; a search expands groups containing matches. */
  instanceGroupExpanded(groupId: string): boolean {
    return this.instanceSearch().trim()
      ? !this.collapsedSearchInstanceGroups().has(groupId)
      : this.expandedInstanceGroups().has(groupId);
  }
  /** Updates search text and resets temporary group collapses for the new query. */
  setInstanceSearch(value: string): void {
    this.instanceSearch.set(value);
    this.collapsedSearchInstanceGroups.set(new Set());
  }
  /** Toggles one plugin profile's instance group. */
  toggleInstanceGroup(groupId: string): void {
    if (this.instanceSearch().trim()) {
      this.collapsedSearchInstanceGroups.update((collapsed) => {
        const next = new Set(collapsed);
        if (next.has(groupId)) next.delete(groupId);
        else next.add(groupId);
        return next;
      });
      return;
    }
    this.expandedInstanceGroups.update((expanded) => {
      const next = new Set(expanded);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }
  /** Opens every currently visible plugin group. */
  expandInstanceGroups(): void {
    if (this.instanceSearch().trim()) {
      this.collapsedSearchInstanceGroups.set(new Set());
      return;
    }
    this.expandedInstanceGroups.set(new Set(this.instanceGroups.map((group) => group.id)));
  }
  /** Closes every plugin group. */
  collapseInstanceGroups(): void {
    if (this.instanceSearch().trim()) {
      this.collapsedSearchInstanceGroups.set(new Set(this.instanceGroups.map((group) => group.id)));
      return;
    }
    this.expandedInstanceGroups.set(new Set());
  }
  /** Lists panels where an instance is assigned to a favorite, built-in page, observer, or home tile. */
  panelNames(instance: PluginInstance): string[] {
    const config = this.manager.config();
    const boundPanelIds = new Set(config.panelBindings
      .filter((binding) => binding.pluginInstanceId === instance.id)
      .map((binding) => binding.panelId));
    return config.panels
      .filter((panel) => boundPanelIds.has(panel.id)
        || Object.values(panel.nativePluginInstances ?? {}).includes(instance.id)
        || Object.values(panel.panelEventPluginInstances ?? {}).includes(instance.id)
        || panel.settings.buttons.some((button) => button.pluginInstanceId === instance.id))
      .map((panel) => panel.name)
      .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
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

  /** Combines plugin-declared fields with variables required by configured topic templates. */
  private profileVariableFields(pluginProfileId: string): NonNullable<PluginDefinition["instanceVariableFields"]> {
    const profile = this.manager.config().pluginProfiles.find((item) => item.id === pluginProfileId);
    const definition = this.definitions().find((item) => item.id === profile?.pluginId);
    if (!profile || !definition) return [];

    const fields = [...(definition.instanceVariableFields ?? [])];
    const topicFields = definition.configSchema.filter((field) => /topic|filter|suffix/i.test(field.key));
    for (const [key, value] of Object.entries(profile.config)) {
      const label = topicFields.find((field) => field.key === key)?.label;
      if (!label || typeof value !== "string") continue;
      for (const [, variableName] of value.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) {
        const knownFieldIndex = fields.findIndex((field) => field.key === variableName);
        if (knownFieldIndex >= 0) {
          if (!fields[knownFieldIndex].required) {
            fields[knownFieldIndex] = {
              ...fields[knownFieldIndex],
              required: true,
              help: fields[knownFieldIndex].help ?? `Required because this plugin profile references {{${variableName}}} in ${label}.`
            };
          }
          continue;
        }
        fields.push({
          key: variableName,
          label: variableName,
          required: true,
          help: `Required because this plugin profile references {{${variableName}}} in ${label}.`
        });
      }
    }
    return fields;
  }

  /** Adds blank values for schema-defined instance fields while retaining saved custom variables. */
  private withProfileVariableDefaults(pluginProfileId: string, variables: Record<string, string>): Record<string, string> {
    return Object.fromEntries([
      ...Object.entries(variables),
      ...this.profileVariableFields(pluginProfileId)
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

  /** Starts a new preview path from the currently selected scripted page. */
  startPreviewPage(): void { this.previewHistory.set([]); this.previewPage(); }

  /** Renders an unsaved page or safely simulates one button with sample MQTT input. */
  previewPage(actionSlot?: number): void {
    const definition = this.selectedDefinition;
    if (!definition || !this.previewTopic().trim() || !this.previewPageId()) return;
    const previous = this.pagePreview();
    this.previewingPage.set(true);
    if (actionSlot === undefined) this.pagePreview.set(null);
    this.pagePreviewError.set("");
    this.pagePreviewNotice.set("");
    this.manager.previewPluginPage({
      pluginId: definition.id,
      config: structuredClone(this.instanceConfig()),
      variables: { ...this.instanceVariables() },
      pageId: this.previewPageId(),
      topic: this.previewTopic().trim(),
      payload: this.previewPayload(),
      ...(actionSlot === undefined ? {} : { actionSlot })
    }).subscribe({
      next: (result) => {
        if (actionSlot !== undefined) {
          if (previous && result.pageId !== previous.pageId && result.pageId !== "exit") {
            this.previewHistory.update((history) => [...history, previous.pageId]);
          }
          if (result.pageId !== "exit") this.previewPageId.set(result.pageId);
          const commands = result.commands ?? [];
          this.pagePreviewNotice.set(commands.length
            ? commands.map((command) => this.manager.translateText("PLUGINS.WOULD_PUBLISH", { topic: command.topic, payload: command.payload })).join("\n")
            : result.pageId === "exit" ? "PLUGINS.ACTION_LEAVES_PAGE"
              : result.rendered ? this.manager.translateText("PLUGINS.BUTTON_SIMULATED", { number: actionSlot ?? 0 }) : "PLUGINS.ACTION_NO_UPDATE");
        }
        this.pagePreview.set(result.rendered || !previous ? result : { ...previous, debugLogs: result.debugLogs });
        this.previewingPage.set(false);
      },
      error: (error) => {
        this.pagePreviewError.set(error.error?.error || "PLUGINS.ERROR_RENDER_PREVIEW");
        this.previewingPage.set(false);
      }
    });
  }

  /** Sends a scripted button through the disposable API preview context. */
  pressPreviewButton(index: number): void {
    if (!this.pagePreview()?.rendered || this.previewingPage()) return;
    this.previewPage(index + 1);
  }

  /** Re-renders the previous scripted page with the same sample MQTT message. */
  pressPreviewBack(): void {
    const history = this.previewHistory();
    const pageId = history.at(-1);
    if (!pageId || this.previewingPage()) return;
    this.previewHistory.set(history.slice(0, -1));
    this.previewPageId.set(pageId);
    this.previewPage();
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
    this.pagePreviewNotice.set("");
    this.previewHistory.set([]);
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
