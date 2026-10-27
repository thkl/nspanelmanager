import { Component, OnInit, signal } from "@angular/core";
import { DatePipe } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { TranslatePipe } from "@ngx-translate/core";
import type { AuthUser } from "../../models";
import { ManagerStore } from "../../manager-store.service";

/** Manages local administrator accounts and their optional linked SSO identities. */
@Component({
  selector: "nspanel-users-page",
  standalone: true,
  imports: [DatePipe, FormsModule, TranslatePipe],
  templateUrl: "./users-page.component.html",
  styleUrl: "./users-page.component.css"
})
export class UsersPageComponent implements OnInit {
  readonly users = signal<AuthUser[]>([]);
  readonly email = signal("");
  readonly password = signal("");
  readonly resetPasswords = signal<Record<string, string>>({});
  readonly loading = signal(false);
  readonly error = signal("");

  /** Receives the shared account API and manager notice service. */
  constructor(readonly manager: ManagerStore) {}

  /** Loads the current account list when the feature page is opened. */
  ngOnInit(): void { this.refresh(); }

  /** Fetches the credential-free local user list. */
  refresh(): void {
    this.loading.set(true);
    this.manager.loadUsers().subscribe({
      next: ({ users }) => { this.users.set(users); this.loading.set(false); },
      error: () => { this.error.set("USERS.ERROR_LOAD"); this.loading.set(false); }
    });
  }

  /** Creates a local administrator with a password stored only as a slow hash. */
  createUser(): void {
    this.error.set("");
    this.manager.createUser(this.email(), this.password()).subscribe({
      next: ({ user }) => {
        this.users.update((users) => [...users, user]);
        this.email.set("");
        this.password.set("");
        this.manager.inform("USERS.NOTICE_CREATED", "success", { email: user.email });
      },
      error: (error) => this.error.set(error.error?.error || "USERS.ERROR_CREATE")
    });
  }

  /** Enables or disables a local account and immediately reflects the saved state. */
  toggleUser(user: AuthUser): void {
    this.error.set("");
    this.manager.updateUser(user.id, { enabled: !user.enabled }).subscribe({
      next: ({ user: updated }) => this.replaceUser(updated),
      error: (error) => this.error.set(error.error?.error || "USERS.ERROR_UPDATE")
    });
  }

  /** Resets another account's password and clears the unsaved password field. */
  resetPassword(user: AuthUser): void {
    const password = this.resetPasswords()[user.id] ?? "";
    this.error.set("");
    this.manager.updateUser(user.id, { password }).subscribe({
      next: ({ user: updated }) => {
        this.replaceUser(updated);
        this.resetPasswords.update((passwords) => ({ ...passwords, [user.id]: "" }));
        this.manager.inform("USERS.NOTICE_PASSWORD_RESET", "success", { email: user.email });
      },
      error: (error) => this.error.set(error.error?.error || "USERS.ERROR_RESET_PASSWORD")
    });
  }

  /** Removes a local account after confirmation; the final enabled administrator is protected by the API. */
  removeUser(user: AuthUser): void {
    if (!this.manager.confirm("USERS.CONFIRM_REMOVE", { email: user.email })) return;
    this.error.set("");
    this.manager.removeUser(user.id).subscribe({
      next: () => {
        this.users.update((users) => users.filter((item) => item.id !== user.id));
        this.manager.inform("USERS.NOTICE_REMOVED", "success", { email: user.email });
      },
      error: (error) => this.error.set(error.error?.error || "USERS.ERROR_REMOVE")
    });
  }

  /** Stores the per-account password field without adding it to shared manager state. */
  setResetPassword(userId: string, password: string): void {
    this.resetPasswords.update((current) => ({ ...current, [userId]: password }));
  }

  private replaceUser(updated: AuthUser): void {
    this.users.update((users) => users.map((user) => user.id === updated.id ? updated : user));
  }
}
