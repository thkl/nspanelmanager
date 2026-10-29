import { Component } from "@angular/core";
import { TranslatePipe } from "@ngx-translate/core";

/** Collects short operational guidance and links MQTT examples to the manager's actual contracts. */
@Component({
  selector: "nspanel-help-page",
  standalone: true,
  imports: [TranslatePipe],
  templateUrl: "./help-page.component.html",
  styleUrl: "./help-page.component.css"
})
export class HelpPageComponent {
  readonly healthEventExample = `{
  "schema_version": 1,
  "event_id": "9cb7c74f-1c0f-487b-9836-6113f479e82c",
  "event": "panel.unexpected_reboot",
  "severity": "critical",
  "timestamp": "2026-10-29T08:15:00.000Z",
  "panel": {
    "id": "panel-id",
    "name": "Hallway",
    "node_name": "nsp-hallway"
  },
  "details": {
    "reset_reason": "panic"
  }
}`;
}
