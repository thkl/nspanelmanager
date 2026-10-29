import { Component, OnInit, computed, input, output, signal } from "@angular/core";
import { DatePipe } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { TranslatePipe } from "@ngx-translate/core";
import { concatMap, from, of, switchMap, toArray, type Observable } from "rxjs";
import { ManagerStore } from "../../manager-store.service";
import type { CoreDumpRecord, DiscoveredPanel, Panel, PanelBinding, PanelGroupSettingsDelivery, PanelGroupSettingsStatus, PanelTelemetry, PluginDefinition } from "../../models";
import { PanelScreenPreviewComponent } from "./panel-screen-preview.component";

interface PanelHealthAlert {
  panelId: string;
  panelName: string;
  severity: "critical" | "warning";
  message: string;
  params?: Record<string, string | number>;
  clearable?: boolean;
}

/**
 * Edits the persisted per-panel display profile and favorite-to-plugin bindings.
 *
 * A panel's draft is a detached copy of the server record, so choosing another
 * panel or refreshing cannot silently mutate the shared manager state. Saving
 * synchronizes favorite bindings and persists the profile; copying sends saved
 * settings to another profile while keeping its identity; applying publishes the
 * firmware's supported settings packet to the selected panel's settings topic.
 */
@Component({
  selector: "nspanel-panel-page",
  standalone: true,
  imports: [DatePipe, FormsModule, PanelScreenPreviewComponent, TranslatePipe],
  templateUrl: "./panel-page.component.html",
  styleUrl: "./panel-page.component.css"
})
export class PanelPageComponent implements OnInit {
  readonly rememberedPanelId = input<string | null>(null);
  readonly panelSelectionChange = output<string | null>();
  readonly selectedPanelId = signal<string | null>(null);
  readonly mobileDetailsOpen = signal(false);
  readonly pluginDefinitions = signal<PluginDefinition[]>([]);
  readonly draft = signal<Panel | null>(null);
  readonly favoriteInstances = signal<Record<number, string>>({});
  readonly addingPanel = signal(false);
  readonly newName = signal("");
  readonly newNodeName = signal("");
  readonly newMacAddress = signal("");
  readonly discoveryAssignmentTargets = signal<Record<string, string>>({});
  readonly showCopySettings = signal(false);
  readonly copyTargetPanelId = signal("");
  readonly copyingPanelSettings = signal(false);
  readonly saving = signal(false);
  readonly savingHealthPreferencePanelId = signal("");
  readonly clearingResetReportPanelId = signal("");
  readonly rebootingPanelId = signal("");
  readonly coreDump = signal<CoreDumpRecord | null>(null);
  readonly coreDumpLoading = signal(false);
  readonly downloadingCoreDump = signal(false);
  readonly healthAlerts = computed(() => this.computeHealthAlerts());

  /** Receives the shared API store used to load and persist panel profiles. */
  constructor(readonly manager: ManagerStore) {}

  /** Formats the latest firmware metrics for compact display in the panel list. */
  formatTelemetry(telemetry: PanelTelemetry): string {
    const parts: string[] = [];
    if (telemetry.firmwareVersion) parts.push(this.manager.translateText("PANEL.TELEMETRY_FW", { version: telemetry.firmwareVersion }));
    if (telemetry.hmiVersion) parts.push(this.manager.translateText("PANEL.TELEMETRY_HMI", { version: telemetry.hmiVersion.slice(0, 12) }));
    if (Number.isFinite(telemetry.uptimeSeconds)) parts.push(this.manager.translateText("PANEL.TELEMETRY_UPTIME", { uptime: formatUptime(telemetry.uptimeSeconds!) }));
    if (Number.isFinite(telemetry.freeHeapBytes)) parts.push(this.manager.translateText("PANEL.TELEMETRY_FREE", { size: formatKilobytes(telemetry.freeHeapBytes!) }));
    if (Number.isFinite(telemetry.minFreeHeapBytes)) parts.push(this.manager.translateText("PANEL.TELEMETRY_MIN", { size: formatKilobytes(telemetry.minFreeHeapBytes!) }));
    if (Number.isFinite(telemetry.largestFreeBlockBytes)) parts.push(this.manager.translateText("PANEL.TELEMETRY_LARGEST", { size: formatKilobytes(telemetry.largestFreeBlockBytes!) }));
    if (Number.isFinite(telemetry.loopTimeMs)) parts.push(this.manager.translateText("PANEL.TELEMETRY_LOOP", { ms: Math.round(telemetry.loopTimeMs!) }));
    if (Number.isFinite(telemetry.chipTemperatureC)) parts.push(this.manager.translateText("PANEL.TELEMETRY_CHIP", { temperature: telemetry.chipTemperatureC!.toFixed(1) }));
    return parts.join(" · ");
  }

  /** Formats the manager's latest requested group values for one panel. */
  formatGroupSettings(status: PanelGroupSettingsStatus): string {
    const parts = [
      this.manager.translateText("PANEL.GROUP_STATUS_GROUP", { name: status.groupName }),
      this.groupSettingsDeliveryLabel(status.delivery)
    ];
    if (status.night !== undefined) parts.push(this.manager.translateText(status.night === 1 ? "PANEL.NIGHT_ON" : "PANEL.NIGHT_OFF"));
    if (status.brightness !== undefined) parts.push(this.manager.translateText("PANEL.GROUP_STATUS_BRIGHTNESS", { value: status.brightness }));
    return parts.join(" · ");
  }

  /** Converts delivery states into short panel-list labels. */
  groupSettingsDeliveryLabel(delivery: PanelGroupSettingsDelivery): string {
    switch (delivery) {
      case "not_sent": return this.manager.translateText("PANEL.DELIVERY_NOT_SENT");
      case "pending": return this.manager.translateText("PANEL.DELIVERY_PENDING");
      case "applied": return this.manager.translateText("PANEL.DELIVERY_APPLIED");
      case "timed_out": return this.manager.translateText("PANEL.DELIVERY_TIMED_OUT");
      case "unconfirmed": return this.manager.translateText("PANEL.DELIVERY_UNCONFIRMED");
      case "publish_failed": return this.manager.translateText("PANEL.DELIVERY_PUBLISH_FAILED");
      case "failed": return this.manager.translateText("PANEL.DELIVERY_FAILED");
    }
  }

  /** Builds actionable alerts from the latest panel connectivity and telemetry. */
  private computeHealthAlerts(): PanelHealthAlert[] {
    const connections = this.manager.panelConnections();
    const alerts: PanelHealthAlert[] = [];
    for (const panel of this.manager.config().panels) {
      if (panel.healthNotificationsEnabled === false) continue;
      const connection = connections[panel.nodeName];
      if (connection && connection.status !== "online" && connection.offlineAlertSuppressed !== true) {
        alerts.push({ panelId: panel.id, panelName: panel.name, severity: "warning", message: "PANEL.ALERT_OFFLINE" });
      }
      const rebootReason = connection?.lastResetReport?.reason.toLowerCase() ?? "";
      if (/(panic|watchdog|brownout|assert|abort|crash)/.test(rebootReason)) {
        alerts.push({ panelId: panel.id, panelName: panel.name, severity: "critical", message: "PANEL.ALERT_REBOOT", params: { reason: connection?.lastResetReport?.reason ?? "unknown" }, clearable: true });
      }
      const freeHeapBytes = connection?.telemetry?.freeHeapBytes;
      const minimumHeapBytes = connection?.telemetry?.minFreeHeapBytes;
      if (freeHeapBytes !== undefined && freeHeapBytes < 32 * 1024) {
        alerts.push({ panelId: panel.id, panelName: panel.name, severity: "warning", message: "PANEL.ALERT_FREE_HEAP", params: { kb: Math.round(freeHeapBytes / 1024) } });
      } else if (minimumHeapBytes !== undefined && minimumHeapBytes < 20 * 1024) {
        alerts.push({ panelId: panel.id, panelName: panel.name, severity: "warning", message: "PANEL.ALERT_MIN_FREE_HEAP", params: { kb: Math.round(minimumHeapBytes / 1024) } });
      }
    }
    return alerts;
  }

  /** Clears a panel's saved reboot report while preserving its current live status. */
  clearResetReport(panelId: string): void {
    if (this.clearingResetReportPanelId()) return;
    this.clearingResetReportPanelId.set(panelId);
    this.manager.clearPanelResetReport(panelId).subscribe({
      next: ({ panel }) => {
        this.clearingResetReportPanelId.set("");
        const panelName = this.manager.config().panels.find((item) => item.id === panel.panelId)?.name ?? panel.nodeName;
        this.manager.inform("PANEL.NOTICE_REPORT_CLEARED", "success", { name: panelName });
      },
      error: (error) => {
        this.clearingResetReportPanelId.set("");
        this.manager.inform(error.error?.error || "PANEL.ERROR_CLEAR_REPORT", "error");
      }
    });
  }

  /** Saves a panel's health-alert preference without disturbing other unsaved panel edits. */
  setHealthNotificationsEnabled(panel: Panel, enabled: boolean): void {
    if (this.savingHealthPreferencePanelId()) return;
    this.savingHealthPreferencePanelId.set(panel.id);
    this.manager.setPanelHealthNotifications(panel.id, enabled).subscribe({
      next: ({ panel: saved }) => {
        this.savingHealthPreferencePanelId.set("");
        this.draft.update((current) => current?.id === saved.id
          ? { ...current, healthNotificationsEnabled: saved.healthNotificationsEnabled }
          : current);
        this.manager.inform(enabled ? "PANEL.NOTICE_HEALTH_ENABLED" : "PANEL.NOTICE_HEALTH_MUTED", "success", { name: saved.name });
      },
      error: (error) => {
        this.savingHealthPreferencePanelId.set("");
        this.manager.inform(error.error?.error || "PANEL.ERROR_HEALTH_PREFERENCE", "error");
      }
    });
  }

  /** Opens the settings editor for a panel named in a health alert. */
  openPanelFromAlert(panelId: string): void {
    const panel = this.manager.config().panels.find((item) => item.id === panelId);
    if (panel) this.selectPanel(panel);
  }

  /** Estimates the latest boot time from the manager receipt time and panel uptime. */
  approximateBootTime(telemetry: PanelTelemetry): number | null {
    const uptimeSeconds = telemetry.uptimeSeconds;
    if (typeof uptimeSeconds !== "number" || !Number.isFinite(uptimeSeconds) || uptimeSeconds < 0) return null;
    return telemetry.reportedAt - uptimeSeconds * 1000;
  }

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
    // Keep the last edited panel selected across feature navigation and configuration refreshes.
    const previousId = this.selectedPanelId() ?? this.rememberedPanelId();
    this.manager.refresh().subscribe({
      next: ({ config }) => {
        const next = config.panels.find((panel) => panel.id === previousId) ?? config.panels[0] ?? null;
        this.setDraft(next);
      },
      error: () => this.manager.inform("PANEL.ERROR_LOAD", "error")
    });
  }

  /** Switches the editor to a separate copy of the chosen panel. */
  selectPanel(panel: Panel): void {
    this.mobileDetailsOpen.set(true);
    // Editing always starts from a detached draft; list selection must not mutate saved shared state.
    this.setDraft(panel);
  }

  /** Returns from the focused mobile editor to the panel list. */
  showPanelList(): void {
    this.mobileDetailsOpen.set(false);
  }

  /** Creates a new panel profile from the user-visible name and firmware node name. */
  addPanel(): void {
    const name = this.newName().trim();
    const nodeName = this.newNodeName().trim();
    const macAddress = this.newMacAddress().trim();
    this.manager.addPanel({ name, nodeName, ...(macAddress ? { macAddress } : {}) }).subscribe({
      next: ({ panel }) => {
        this.mobileDetailsOpen.set(true);
        this.setDraft(panel);
        this.newName.set("");
        this.newNodeName.set("");
        this.newMacAddress.set("");
        this.addingPanel.set(false);
        this.manager.inform("PANEL.NOTICE_ADDED", "success");
      },
      error: (error) => this.manager.inform(error.error?.error || "PANEL.ERROR_ADD", "error")
    });
  }

  /** Lists possible destinations other than the source panel. */
  copyTargets(source: Panel): Panel[] {
    return this.manager.config().panels.filter((panel) => panel.id !== source.id);
  }

  /** Copies the source's saved configuration onto the selected destination panel. */
  copySettingsToPanel(): void {
    const source = this.draft();
    const target = this.manager.config().panels.find((panel) => panel.id === this.copyTargetPanelId());
    if (!source || !target || this.copyingPanelSettings()) return;
    if (!this.manager.confirm("PANEL.CONFIRM_COPY_SETTINGS", { target: target.name, source: source.name })) return;

    this.copyingPanelSettings.set(true);
    this.manager.copyPanelSettings(source.id, target.id).subscribe({
      next: ({ published, topic }) => {
        this.copyingPanelSettings.set(false);
        this.showCopySettings.set(false);
        this.copyTargetPanelId.set("");
        this.manager.inform(published ? "PANEL.NOTICE_COPIED_SENT" : "PANEL.NOTICE_COPIED_QUEUED", "success", { name: target.name, topic });
      },
      error: (error) => {
        this.copyingPanelSettings.set(false);
        this.manager.inform(error.error?.error || "PANEL.ERROR_COPY_SETTINGS", "error");
      }
    });
  }

  /** Closes the copy controls without changing either panel. */
  cancelCopySettings(): void {
    this.showCopySettings.set(false);
    this.copyTargetPanelId.set("");
  }

  /** Requests a fresh discovery broadcast from ESPHome devices on the connected broker. */
  discoverPanels(): void {
    this.manager.requestPanelDiscovery().subscribe({
      next: () => this.manager.inform("PANEL.NOTICE_DISCOVERY_REQUESTED"),
      error: (error) => this.manager.inform(error.error?.error || "PANEL.ERROR_DISCOVERY", "error")
    });
  }

  /** Returns the configured panel currently associated with a discovered device. */
  assignedPanel(device: DiscoveredPanel): Panel | undefined {
    return this.manager.config().panels.find((panel) => normalizeMacAddress(panel.macAddress) === device.macAddress);
  }

  /** Lists profiles that can receive this device, including a profile already assigned to it. */
  availableAssignmentPanels(device: DiscoveredPanel): Panel[] {
    return this.manager.config().panels.filter((panel) => !panel.macAddress || normalizeMacAddress(panel.macAddress) === device.macAddress);
  }

  /** Stores the panel selected for a discovered device before the assignment is saved. */
  setDiscoveryAssignment(macAddress: string, panelId: string): void {
    this.discoveryAssignmentTargets.update((targets) => ({ ...targets, [macAddress]: panelId }));
  }

  /** Persists the selected device MAC on its manager panel profile. */
  assignDiscoveredPanel(device: DiscoveredPanel): void {
    const panelId = this.discoveryAssignmentTargets()[device.macAddress];
    if (!panelId) return;
    this.manager.setPanelMacAddress(panelId, device.macAddress).subscribe({
      next: ({ panel, published, command, topic }) => {
        this.discoveryAssignmentTargets.update((targets) => ({ ...targets, [device.macAddress]: "" }));
        if (this.draft()?.id === panel.id) this.setDraft(panel);
        if (command === "identity" && published) {
          this.manager.inform("PANEL.NOTICE_IDENTITY_SENT", "success", { mac: device.macAddress, name: panel.name, topic: topic ?? "" });
        } else if (command === "identity") {
          this.manager.inform("PANEL.NOTICE_IDENTITY_QUEUED", "success", { mac: device.macAddress, name: panel.name });
        } else if (command === "settings" && published) {
          this.manager.inform("PANEL.NOTICE_ASSIGNMENT_SENT", "success", { mac: device.macAddress, name: panel.name, topic: topic ?? "" });
        } else if (command === "settings") {
          this.manager.inform("PANEL.NOTICE_ASSIGNMENT_QUEUED", "success", { mac: device.macAddress, name: panel.name });
        } else {
          this.manager.inform("PANEL.NOTICE_DEVICE_CLEARED", "success", { name: panel.name });
        }
      },
      error: (error) => this.manager.inform(error.error?.error || "PANEL.ERROR_ASSIGN_DEVICE", "error")
    });
  }

  /** Clears the hardware identity from the currently selected manager panel. */
  clearPanelMacAddress(panel: Panel): void {
    this.manager.setPanelMacAddress(panel.id, null).subscribe({
      next: ({ panel: saved }) => {
        if (this.draft()?.id === saved.id) this.setDraft(saved);
        this.manager.inform("PANEL.NOTICE_DEVICE_CLEARED", "success", { name: saved.name });
      },
      error: (error) => this.manager.inform(error.error?.error || "PANEL.ERROR_CLEAR_DEVICE", "error")
    });
  }

  /** Starts a panel profile form prefilled with the discovered device identity. */
  createPanelFromDiscovery(device: DiscoveredPanel): void {
    this.newName.set(device.friendlyName || device.name);
    this.newNodeName.set(device.name);
    this.newMacAddress.set(device.macAddress);
    this.addingPanel.set(true);
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
        this.manager.inform(published ? "PANEL.NOTICE_SETTINGS_SAVED_SENT" : "PANEL.NOTICE_SETTINGS_SAVED_QUEUED", "success", { topic });
      },
      error: (error) => { this.saving.set(false); this.manager.inform(error.error?.error || "PANEL.ERROR_SAVE_SETTINGS", "error"); }
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

  /** Lists enabled plugin instances that expose a direct toggle action. */
  hardwareToggleInstances() {
    const togglePluginIds = new Set(this.pluginDefinitions()
      .filter((plugin) => plugin.capabilities.includes("favorite-toggle"))
      .flatMap((plugin) => [plugin.id, ...(plugin.aliases ?? [])]));
    const profileIds = new Set(this.manager.config().pluginProfiles
      .filter((profile) => togglePluginIds.has(profile.pluginId))
      .map((profile) => profile.id));
    return this.manager.config().pluginInstances.filter((instance) => instance.enabled && profileIds.has(instance.pluginProfileId));
  }

  /** Returns the physical button's selected relay, event, or plugin action. */
  hardwareButtonAction(index: "0" | "1"): string {
    const pluginInstanceId = this.draft()?.hardwareButtonPluginInstances?.[index];
    if (pluginInstanceId) return `plugin:${pluginInstanceId}`;
    return this.draft()?.settings.hwbuttons[index] === 0 ? "relay" : "event";
  }

  /** Returns a stale assignment so the editor can display and clear it. */
  unavailableHardwareButtonPlugin(index: "0" | "1"): string {
    const pluginInstanceId = this.draft()?.hardwareButtonPluginInstances?.[index] ?? "";
    return pluginInstanceId && !this.hardwareToggleInstances().some((instance) => instance.id === pluginInstanceId) ? pluginInstanceId : "";
  }

  /** Assigns a toggle-capable plugin or restores the selected relay/event mode. */
  setHardwareButtonAction(index: "0" | "1", action: string): void {
    const panel = this.draft();
    if (!panel) return;
    if (action.startsWith("plugin:")) {
      const pluginInstanceId = action.slice("plugin:".length);
      if (!this.hardwareToggleInstances().some((instance) => instance.id === pluginInstanceId)) return;
      panel.hardwareButtonPluginInstances = { ...(panel.hardwareButtonPluginInstances ?? {}), [index]: pluginInstanceId };
      panel.settings.hwbuttons[index] = 1;
      return;
    }
    const assignments = { ...(panel.hardwareButtonPluginInstances ?? {}) };
    delete assignments[index];
    panel.hardwareButtonPluginInstances = assignments;
    panel.settings.hwbuttons[index] = action === "relay" ? 0 : 1;
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
    if (pageId === "thermostat") return this.manager.translateText("PANEL.NATIVE_PAGE_THERMOSTAT");
    if (pageId === "weather") return this.manager.translateText("PANEL.NATIVE_PAGE_WEATHER");
    if (pageId === "music") return this.manager.translateText("PANEL.NATIVE_PAGE_MUSIC");
    return this.manager.translateText("PANEL.NATIVE_PAGE_GENERIC", { page: pageId });
  }

  /** Lists enabled or saved instances whose plugin can drive a main-screen tile. */
  homeTileInstances() {
    const profiles = this.manager.config().pluginProfiles;
    const definitions = this.pluginDefinitions();
    return this.manager.config().pluginInstances.filter((instance) => {
      const profile = profiles.find((candidate) => candidate.id === instance.pluginProfileId);
      const definition = definitions.find((candidate) => candidate.id === profile?.pluginId);
      if (definition?.homeTileType) return true;
      const entityDomain = instance.variables.entityId?.split(".")[0]?.toLowerCase();
      return Boolean(entityDomain && definition?.homeTileTypeByEntityDomain?.[entityDomain]);
    });
  }

  /** Returns the configured light or cover capability for an assigned instance. */
  homeTileType(pluginInstanceId?: string): "light" | "cover" | undefined {
    const instance = this.homeTileInstances().find((candidate) => candidate.id === pluginInstanceId);
    const profile = instance && this.manager.config().pluginProfiles.find((candidate) => candidate.id === instance.pluginProfileId);
    const definition = this.pluginDefinitions().find((plugin) => plugin.id === profile?.pluginId);
    const entityDomain = instance?.variables.entityId?.split(".")[0]?.toLowerCase();
    const entityTileType = entityDomain ? definition?.homeTileTypeByEntityDomain?.[entityDomain] : undefined;
    return entityTileType ?? definition?.homeTileType;
  }

  /** Reports whether the selected tile plugin can use the panel's level page. */
  supportsHomeTileLevelPage(pluginInstanceId?: string): boolean {
    const instance = this.homeTileInstances().find((candidate) => candidate.id === pluginInstanceId);
    const profile = instance && this.manager.config().pluginProfiles.find((candidate) => candidate.id === instance.pluginProfileId);
    const definition = this.pluginDefinitions().find((plugin) => plugin.id === profile?.pluginId);
    return this.homeTileType(pluginInstanceId) === "cover" || definition?.homeTileSupportsLevelPage === true;
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
        this.manager.inform("PANEL.NOTICE_SETTINGS_SENT", "success", { topic });
      },
      error: (error) => {
        this.saving.set(false);
        this.manager.inform(error.error?.error || "PANEL.ERROR_APPLY_SETTINGS", "error");
      }
    });
  }

  /** Sends the firmware-supported reboot command after confirming the selected panel is online. */
  rebootPanel(panel: Panel): void {
    if (this.rebootingPanelId() || !this.manager.mqtt().connected
      || this.manager.panelConnections()[panel.nodeName]?.status !== "online") return;
    if (!this.manager.confirm("PANEL.CONFIRM_REBOOT", { name: panel.name })) return;
    this.rebootingPanelId.set(panel.id);
    this.manager.rebootPanel(panel.id).subscribe({
      next: ({ topic }) => {
        this.rebootingPanelId.set("");
        this.manager.inform("PANEL.NOTICE_REBOOT_SENT", "success", { name: panel.name, topic });
      },
      error: (error) => {
        this.rebootingPanelId.set("");
        this.manager.inform(error.error?.error || "PANEL.ERROR_REBOOT", "error");
      }
    });
  }

  /** Removes a panel after confirmation and resets the selected editor. */
  removePanel(): void {
    const panel = this.draft();
    if (!panel || !this.manager.confirm("PANEL.CONFIRM_REMOVE", { name: panel.name })) return;
    this.manager.removePanel(panel).subscribe({
      next: () => {
        const next = this.manager.config().panels[0] ?? null;
        this.setDraft(next);
        this.manager.inform("PANEL.NOTICE_REMOVED");
      },
      error: () => this.manager.inform("PANEL.ERROR_REMOVE", "error")
    });
  }

  /** Downloads the latest crash dump saved by the manager for the selected panel. */
  downloadCoreDump(): void {
    const panel = this.draft();
    const dump = this.coreDumpForSelectedPanel();
    if (!panel || !dump || this.downloadingCoreDump()) return;
    this.downloadingCoreDump.set(true);
    this.manager.downloadPanelCoreDump(panel.id).subscribe({
      next: (file) => {
        const url = URL.createObjectURL(file);
        const link = document.createElement("a");
        link.href = url;
        link.download = `nspanel-${panel.nodeName}-${dump.dumpId}-coredump.bin`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        this.downloadingCoreDump.set(false);
      },
      error: () => {
        this.downloadingCoreDump.set(false);
        this.manager.inform("PANEL.ERROR_DOWNLOAD_DUMP", "error");
      }
    });
  }

  /** Returns the local lookup or the newer dump announced over WebSocket. */
  coreDumpForSelectedPanel(): CoreDumpRecord | null {
    const panelId = this.selectedPanelId();
    return panelId ? this.manager.panelCoreDumps()[panelId] ?? this.coreDump() : null;
  }

  private setDraft(panel: Panel | null): void {
    if (this.selectedPanelId() !== (panel?.id ?? null)) {
      this.showCopySettings.set(false);
      this.copyTargetPanelId.set("");
    }
    this.selectedPanelId.set(panel?.id ?? null);
    this.panelSelectionChange.emit(panel?.id ?? null);
    this.draft.set(panel ? structuredClone(panel) : null);
    this.loadCoreDump(panel?.id ?? null);
    const assignments = panel
      ? this.manager.config().panelBindings
        .filter((binding) => binding.panelId === panel.id && binding.trigger.type === "favorite")
        .map((binding) => [binding.trigger.index, binding.pluginInstanceId] as const)
      : [];
    this.favoriteInstances.set(Object.fromEntries(assignments));
  }

  private loadCoreDump(panelId: string | null): void {
    this.coreDump.set(null);
    this.coreDumpLoading.set(Boolean(panelId));
    if (!panelId) return;
    this.manager.loadPanelCoreDump(panelId).subscribe({
      next: ({ dump }) => {
        if (this.selectedPanelId() !== panelId) return;
        this.coreDump.set(dump);
        this.coreDumpLoading.set(false);
      },
      error: () => {
        if (this.selectedPanelId() === panelId) this.coreDumpLoading.set(false);
      }
    });
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

function normalizeMacAddress(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().replace(/[:-]/g, "").toLowerCase();
  return /^[a-f0-9]{12}$/.test(normalized) ? normalized : undefined;
}
