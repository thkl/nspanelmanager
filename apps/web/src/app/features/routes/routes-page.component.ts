import { Component, OnInit, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { TranslatePipe } from "@ngx-translate/core";
import { ManagerStore } from "../../manager-store.service";
import type { MqttRoute, RouteDraft } from "../../models";

/**
 * Creates and removes the manager's generic MQTT topic bridges.
 *
 * External-to-panel routes publish state to a selected panel command topic.
 * Panel-to-external routes listen for a panel event and publish the resulting
 * payload to an integration command topic. The MQTT runtime supports wildcard
 * source filters and simple payload tokens, so users can replace small Node-RED
 * forwarding flows without custom code.
 */
@Component({
  selector: "nspanel-routes-page",
  standalone: true,
  imports: [FormsModule, TranslatePipe],
  templateUrl: "./routes-page.component.html",
  styleUrl: "./routes-page.component.css"
})
export class RoutesPageComponent implements OnInit {
  readonly draft = signal<RouteDraft>(this.emptyDraft());
  readonly editingRouteId = signal<string | null>(null);
  readonly saving = signal(false);

  /** Provides a direction-specific example without placing raw braces in HTML. */
  get targetTopicPlaceholder(): string {
    return this.draft().direction === "external-to-panel"
      ? "{nodeName}/cmnd/thermostate/current"
      : "home/lights/livingroom/set";
  }

  /** Receives shared configuration and route operations from the manager store. */
  constructor(readonly manager: ManagerStore) {}

  /** Ensures the displayed panel labels and routes come from persisted state. */
  ngOnInit(): void { this.refresh(); }

  /** Refreshes server-managed lists without discarding the route being drafted. */
  refresh(): void {
    this.manager.refresh().subscribe({ error: () => this.manager.inform("ROUTES.ERROR_LOAD", "error") });
  }

  /** Adds a route or saves edits to the route currently loaded in the form. */
  saveRoute(): void {
    this.saving.set(true);
    const editingRouteId = this.editingRouteId();
    const request = editingRouteId
      ? this.manager.updateRoute(editingRouteId, this.draft())
      : this.manager.addRoute(this.draft());
    request.subscribe({
      next: () => {
        this.editingRouteId.set(null);
        this.draft.set(this.emptyDraft());
        this.saving.set(false);
        this.manager.inform(editingRouteId ? "ROUTES.NOTICE_UPDATED" : "ROUTES.NOTICE_ADDED");
      },
      error: (error) => {
        this.saving.set(false);
        this.manager.inform(error.error?.error || (editingRouteId ? "ROUTES.ERROR_UPDATE" : "ROUTES.ERROR_ADD"), "error");
      }
    });
  }

  /** Loads a saved route into the form, including its optional payload filter. */
  editRoute(route: MqttRoute): void {
    this.editingRouteId.set(route.id);
    this.draft.set({
      name: route.name,
      direction: route.direction,
      panelId: route.panelId ?? "",
      sourceTopic: route.sourceTopic,
      targetTopic: route.targetTopic,
      payloadTemplate: route.payloadTemplate,
      payloadFilter: route.payloadFilter
        ? {
            mode: route.payloadFilter.mode,
            path: route.payloadFilter.mode === "json-equals" ? route.payloadFilter.path : "",
            value: route.payloadFilter.value
          }
        : { mode: "none", path: "", value: "" }
    });
  }

  /** Clears edit mode and returns the form to its empty new-route state. */
  cancelEdit(): void {
    this.editingRouteId.set(null);
    this.draft.set(this.emptyDraft());
  }

  /** Deletes a route from the broker subscription set and persistent profile. */
  removeRoute(route: MqttRoute): void {
    this.manager.removeRoute(route).subscribe({
      next: () => {
        if (this.editingRouteId() === route.id) this.cancelEdit();
        this.manager.inform("ROUTES.NOTICE_REMOVED");
      },
      error: () => this.manager.inform("ROUTES.ERROR_REMOVE", "error")
    });
  }

  /** Updates route direction and clears a now-inapplicable panel target. */
  setDirection(direction: RouteDraft["direction"]): void {
    this.draft.update((draft) => ({ ...draft, direction, panelId: direction === "external-to-panel" ? draft.panelId : "" }));
  }

  /** Changes the optional payload filter while retaining its current inputs. */
  setFilterMode(mode: RouteDraft["payloadFilter"]["mode"]): void {
    this.draft.update((draft) => ({ ...draft, payloadFilter: { ...draft.payloadFilter, mode } }));
  }

  /** Describes an active filter beside its route so it can be reviewed later. */
  filterSummary(route: MqttRoute): string | undefined {
    const filter = route.payloadFilter;
    if (!filter) return undefined;
    if (filter.mode === "json-equals") {
      return this.manager.translateText("ROUTES.FILTER_SUMMARY_JSON_EQUALS", {
        path: filter.path,
        value: JSON.stringify(filter.value)
      });
    }
    const mode = filter.mode === "contains"
      ? this.manager.translateText("ROUTES.FILTER_CONTAINS")
      : this.manager.translateText("ROUTES.FILTER_EQUALS");
    return `${mode} ${JSON.stringify(filter.value)}`;
  }

  /** Resolves a route's optional panel id into the current human-readable name. */
  panelName(id: string | undefined): string {
    return this.manager.config().panels.find((panel) => panel.id === id)?.name ?? this.manager.translateText("ROUTES.ALL_MATCHING_PANELS");
  }

  private emptyDraft(): RouteDraft {
    return {
      name: "", direction: "external-to-panel", panelId: "", sourceTopic: "", targetTopic: "", payloadTemplate: "{{payload}}",
      payloadFilter: { mode: "none", path: "", value: "" }
    };
  }
}
