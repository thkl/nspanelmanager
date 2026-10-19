import { Component, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { ManagerStore } from "../../manager-store.service";

/** Provides first-run administrator setup, local password sign-in, and optional OIDC entry. */
@Component({
  selector: "nspanel-auth-page",
  standalone: true,
  imports: [FormsModule],
  templateUrl: "./auth-page.component.html",
  styleUrl: "./auth-page.component.css"
})
export class AuthPageComponent {
  readonly email = signal("");
  readonly bootstrapToken = signal("");
  readonly password = signal("");
  readonly confirmPassword = signal("");
  readonly error = signal("");
  readonly signingIn = signal(false);

  /** Receives the shared auth status and typed API methods. */
  constructor(readonly manager: ManagerStore) {
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("login") === "sso-failed") {
      this.error.set("Single sign-on could not link this identity to an enabled local account.");
      window.history.replaceState({}, "", window.location.pathname);
    }
  }

  /** Submits local credentials and lets the app shell reveal the workspace on success. */
  login(): void {
    if (this.signingIn()) return;
    this.signingIn.set(true);
    this.error.set("");
    this.manager.login(this.email(), this.password()).subscribe({
      next: () => { this.password.set(""); this.signingIn.set(false); },
      error: (error) => {
        this.error.set(error.error?.error || "Could not sign in. Check your details and try again.");
        this.password.set("");
        this.signingIn.set(false);
      }
    });
  }

  /** Starts OIDC sign-in and displays API or provider-discovery failures on the login page. */
  startSsoLogin(): void {
    if (this.signingIn()) return;
    this.signingIn.set(true);
    this.error.set("");
    this.manager.startSsoLogin().subscribe({
      next: ({ authorizationUrl }) => { window.location.assign(authorizationUrl); },
      error: (error) => {
        this.error.set(error.error?.error || "Could not start single sign-on. Check the API server log.");
        this.signingIn.set(false);
      }
    });
  }

  /** Creates the first administrator through the one-time onboarding endpoint. */
  createFirstUser(): void {
    if (this.signingIn()) return;
    if (this.password() !== this.confirmPassword()) {
      this.error.set("The passwords do not match.");
      return;
    }
    this.signingIn.set(true);
    this.error.set("");
    this.manager.setupFirstUser(this.email(), this.password(), this.bootstrapToken()).subscribe({
      next: () => {
        this.password.set("");
        this.confirmPassword.set("");
        this.signingIn.set(false);
      },
      error: (error) => {
        this.error.set(error.error?.error || "Could not complete setup. Check the email and password and try again.");
        this.password.set("");
        this.confirmPassword.set("");
        this.signingIn.set(false);
        if (error.status === 409) {
          this.manager.loadAuthStatus().subscribe({ error: () => undefined });
          this.error.set("Initial setup has already been completed. Sign in with the existing account.");
        }
      }
    });
  }
}
