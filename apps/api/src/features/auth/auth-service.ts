import { readFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import * as oidc from "openid-client";
import type { PublicUser } from "./auth.types.js";
import { InitialSetupCompletedError, normalizeEmail, UserStore, validateEmail } from "./user-store.js";
import { PasswordHasher, validatePassword } from "./password-hasher.js";

const sessionLifetimeMs = 12 * 60 * 60 * 1000;
const oidcTransactionLifetimeMs = 10 * 60 * 1000;
const loginWindowMs = 15 * 60 * 1000;
const maximumLoginFailures = 8;
const maximumConcurrentLoginVerifications = 2;

interface OidcTransaction {
  state: string;
  nonce: string;
  codeVerifier: string;
  expiresAt: number;
}

interface LoginAttempt {
  failures: number;
  inFlight: number;
  windowEndsAt: number;
  blockedUntil: number;
}

/** Configured OIDC settings used by login and callback routes. */
interface OidcSettings {
  issuerUrl: URL;
  clientId: string;
  clientSecret: string;
  redirectUrl: URL;
  configuration?: oidc.Configuration;
  discovery?: Promise<oidc.Configuration>;
}

/**
 * Coordinates local credentials, OIDC linking, browser sessions, and account lifecycle.
 * It also owns the per-process first-run token that protects creation of the initial administrator.
 */
export class AuthService {
  private readonly hasher = new PasswordHasher();
  private readonly loginAttempts = new Map<string, LoginAttempt>();
  private activeLoginVerifications = 0;
  private setupInProgress = false;
  private initialSetupToken?: string;
  private readonly oidcIssuerUrl = process.env.OIDC_ISSUER_URL?.trim() ?? "";
  private readonly oidcClientId = process.env.OIDC_CLIENT_ID?.trim() ?? "";
  private readonly oidcClientSecretFile = process.env.OIDC_CLIENT_SECRET_FILE?.trim() ?? "";
  private readonly publicUrl = process.env.APP_PUBLIC_URL?.trim() ?? "";
  private oidcSettings?: OidcSettings;
  private dummyPasswordHash = "";

  /** Receives the durable user store used by local and SSO authentication. */
  constructor(private readonly users: UserStore) {}

  /** Prepares local-login verification, creates a first-run token if needed, and loads optional OIDC settings. */
  async initialize(): Promise<void> {
    this.dummyPasswordHash = await this.hasher.hash("dummy-password-hash-not-a-real-user");
    if (this.users.listUsers().length === 0) this.initialSetupToken = randomBytes(32).toString("hex");
    const publicUrl = this.publicUrl ? parseHttpUrl(this.publicUrl, "APP_PUBLIC_URL") : undefined;
    if (publicUrl && (publicUrl.pathname !== "/" || publicUrl.search)) {
      throw new Error("APP_PUBLIC_URL must be an origin without a path or query string.");
    }
    if (publicUrl) requireSecureUrl(publicUrl, "APP_PUBLIC_URL");
    const provided = [this.oidcIssuerUrl, this.oidcClientId, this.oidcClientSecretFile].filter(Boolean).length;
    if (provided === 0) return;
    if (provided !== 3) throw new Error("Configure OIDC_ISSUER_URL, OIDC_CLIENT_ID, and OIDC_CLIENT_SECRET_FILE together.");
    if (!publicUrl) throw new Error("APP_PUBLIC_URL must be configured when OIDC is enabled.");

    const issuerUrl = parseHttpUrl(this.oidcIssuerUrl, "OIDC_ISSUER_URL");
    if (issuerUrl.search) throw new Error("OIDC_ISSUER_URL must not contain a query string.");
    requireSecureUrl(issuerUrl, "OIDC_ISSUER_URL");
    const redirectUrl = new URL("/api/auth/sso/callback", publicUrl);
    const clientSecret = (await readFile(this.oidcClientSecretFile, "utf8")).trim();
    if (clientSecret.length < 8) throw new Error("The OIDC client secret file is empty or too short.");
    this.oidcSettings = { issuerUrl, clientId: this.oidcClientId, clientSecret, redirectUrl };
  }

  /** Reports login availability and resolves the current browser session. */
  async status(request: Request): Promise<{ authenticated: boolean; user?: PublicUser; ssoEnabled: boolean; hasUsers: boolean }> {
    const user = await this.currentUser(request);
    return { authenticated: Boolean(user), ...(user ? { user } : {}), ssoEnabled: Boolean(this.oidcSettings), hasUsers: this.users.listUsers().length > 0 };
  }

  /** Returns whether OIDC login is configured for the central identity provider. */
  isSsoEnabled(): boolean { return Boolean(this.oidcSettings); }

  /**
   * Returns the in-memory onboarding token for startup logging while no local account exists.
   * The server must expose this value only in its operator-facing startup output, never through HTTP.
   */
  getInitialSetupTokenForStartupLog(): string | undefined {
    return this.users.listUsers().length === 0 ? this.initialSetupToken : undefined;
  }

  /** Authenticates a local email/password pair and issues a revocable session. */
  async login(email: string, password: string, remoteAddress: string): Promise<{ user: PublicUser; token: string }> {
    const attempt = this.getLoginAttempt(remoteAddress);
    const now = Date.now();
    if (attempt.blockedUntil > now) throw new LoginRateLimitError(Math.ceil((attempt.blockedUntil - now) / 1000));
    if (attempt.failures + attempt.inFlight >= maximumLoginFailures) {
      throw new LoginRateLimitError(Math.max(1, Math.ceil((attempt.windowEndsAt - now) / 1000)));
    }
    if (this.activeLoginVerifications >= maximumConcurrentLoginVerifications) {
      if (attempt.failures === 0 && attempt.inFlight === 0 && this.loginAttempts.get(remoteAddress) === attempt) {
        this.loginAttempts.delete(remoteAddress);
      }
      throw new LoginRateLimitError(1);
    }

    attempt.inFlight += 1;
    this.activeLoginVerifications += 1;
    try {
      const normalized = normalizeEmail(email);
      const user = this.users.findByEmail(normalized);
      const passwordInRange = password.length <= 1024;
      const valid = await this.hasher.verify(passwordInRange ? password : password.slice(0, 1024), user?.passwordHash ?? this.dummyPasswordHash);
      if (!passwordInRange || !user || !user.enabled || !valid) {
        this.recordFailedLogin(remoteAddress, attempt);
        throw new InvalidCredentialsError();
      }
      if (user.passwordHash.startsWith("scrypt$")) {
        await this.users.updateUser(user.id, { passwordHash: await this.hasher.hash(password) });
      }
      attempt.failures = 0;
      attempt.blockedUntil = 0;
      return { user: this.toPublicUser(user), token: await this.users.createSession(user.id, Date.now() + sessionLifetimeMs) };
    } finally {
      attempt.inFlight -= 1;
      this.activeLoginVerifications -= 1;
      if (attempt.inFlight === 0 && attempt.failures === 0 && this.loginAttempts.get(remoteAddress) === attempt) {
        this.loginAttempts.delete(remoteAddress);
      }
    }
  }

  /** Begins a PKCE-protected OIDC authorization-code flow and stores its CSRF transaction. */
  async beginSsoLogin(): Promise<{ url: string; token: string }> {
    const settings = this.requireOidc();
    const configuration = await this.discoverOidc();
    const token = randomBytes(32).toString("hex");
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const transaction: OidcTransaction = {
      state: oidc.randomState(),
      nonce: oidc.randomNonce(),
      codeVerifier,
      expiresAt: Date.now() + oidcTransactionLifetimeMs
    };
    await this.users.createOidcTransaction(token, transaction);
    const challenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const authorizationUrl = oidc.buildAuthorizationUrl(configuration, {
      redirect_uri: settings.redirectUrl.href,
      scope: "openid email",
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: transaction.state,
      nonce: transaction.nonce
    });
    return { url: authorizationUrl.href, token };
  }

  /** Validates the OIDC response, links its verified email to a local user, and issues a session. */
  async completeSsoLogin(token: string, currentUrl: URL): Promise<{ user: PublicUser; token: string }> {
    const settings = this.requireOidc();
    const configuration = await this.discoverOidc();
    const transaction = await this.users.consumeOidcTransaction(token);
    if (!transaction || transaction.expiresAt <= Date.now()) throw new InvalidCredentialsError();
    const tokens = await oidc.authorizationCodeGrant(configuration, currentUrl, {
      pkceCodeVerifier: transaction.codeVerifier,
      expectedState: transaction.state,
      expectedNonce: transaction.nonce
    });
    const claims = tokens.claims();
    if (!claims || typeof claims.iss !== "string" || typeof claims.sub !== "string") throw new InvalidCredentialsError();

    const issuer = claims.iss;
    let user = this.users.findByOidcIdentity(issuer, claims.sub);
    if (!user) {
      let email = claims.email;
      let emailVerified = claims.email_verified;
      if (typeof email !== "string" || emailVerified !== true) {
        if (!tokens.access_token) throw new InvalidCredentialsError();
        const profile = await oidc.fetchUserInfo(configuration, tokens.access_token, claims.sub);
        email = profile.email;
        emailVerified = profile.email_verified;
      }
      if (typeof email !== "string" || emailVerified !== true) throw new InvalidCredentialsError();
      const normalizedEmail = normalizeEmail(email);
      validateEmail(normalizedEmail);
      user = this.users.findByEmail(normalizedEmail);
      if (!user?.enabled) throw new InvalidCredentialsError();
      await this.users.linkOidcIdentity(user, issuer, claims.sub);
    }
    if (!user.enabled) throw new InvalidCredentialsError();
    return { user: this.toPublicUser(user), token: await this.users.createSession(user.id, Date.now() + sessionLifetimeMs) };
  }

  /** Invalidates the current browser token during logout. */
  async logout(request: Request): Promise<void> {
    const token = this.sessionToken(request);
    if (token) await this.users.deleteSession(token);
  }

  /** Attaches an enabled local account to an API request when its cookie session is valid. */
  async currentUser(request: Request): Promise<PublicUser | undefined> {
    const token = this.sessionToken(request);
    if (!token) return undefined;
    const user = await this.resolveSessionToken(token);
    if (!user) return undefined;
    request.authUser = user;
    request.authSessionToken = token;
    return request.authUser;
  }

  /** Resolves an opaque session token for authenticated non-HTTP transports such as WebSockets. */
  async resolveSessionToken(token: string): Promise<PublicUser | undefined> {
    const resolved = await this.users.resolveSession(token);
    return resolved ? this.toPublicUser(resolved.user) : undefined;
  }

  /** Returns the callback URI derived from APP_PUBLIC_URL for OIDC authorization responses. */
  getOidcRedirectUrl(): URL { return this.requireOidc().redirectUrl; }

  /** Creates an account after email and password policy validation. */
  async createUser(email: string, password: string): Promise<PublicUser> {
    const normalized = normalizeEmail(email);
    validateEmail(normalized);
    validatePassword(password);
    return this.users.createUser(normalized, await this.hasher.hash(password));
  }

  /**
   * Requires and consumes the startup token to create the sole first administrator and its onboarding session.
   * The supplied token must match the current process token and is accepted only while the user store is empty.
   * @param email Email address for the initial local administrator.
   * @param password Password for the initial local administrator.
   * @param bootstrapToken Random token printed by this process during startup.
   */
  async createInitialUser(email: string, password: string, bootstrapToken: string): Promise<{ user: PublicUser; token: string }> {
    if (this.setupInProgress || this.users.listUsers().length > 0) throw new InitialSetupCompletedError();
    if (!this.matchesInitialSetupToken(bootstrapToken)) throw new InvalidInitialSetupTokenError();
    const normalized = normalizeEmail(email);
    validateEmail(normalized);
    validatePassword(password);
    this.setupInProgress = true;
    try {
      const user = await this.users.createInitialUser(normalized, await this.hasher.hash(password));
      this.initialSetupToken = undefined;
      const token = await this.users.createSession(user.id, Date.now() + sessionLifetimeMs);
      return { user, token };
    } finally {
      this.setupInProgress = false;
    }
  }

  /** Updates a local account's enabled state or administrator-reset password. */
  async updateUser(id: string, update: { password?: string; enabled?: boolean }): Promise<PublicUser | undefined> {
    const passwordHash = update.password === undefined ? undefined : await this.hasher.hash(update.password);
    return this.users.updateUser(id, { ...(passwordHash ? { passwordHash } : {}), ...(typeof update.enabled === "boolean" ? { enabled: update.enabled } : {}) });
  }

  /** Removes one local user and revokes all of that user's active sessions. */
  removeUser(id: string): Promise<boolean> { return this.users.removeUser(id); }

  /** Lists public account records without exposing password hashes or identity claims. */
  listUsers(): PublicUser[] { return this.users.listUsers(); }

  /** Configures an HttpOnly SameSite session cookie with HTTPS protection when the public URL uses TLS. */
  sessionCookie(token: string): string {
    const secure = this.publicUrl.startsWith("https:") ? "; Secure" : "";
    return `nspanel_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(sessionLifetimeMs / 1000)}${secure}`;
  }

  /** Clears the browser session cookie while preserving the configured cookie flags. */
  clearSessionCookie(): string {
    const secure = this.publicUrl.startsWith("https:") ? "; Secure" : "";
    return `nspanel_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure}`;
  }

  /** Sets a separate short-lived OIDC transaction cookie without replacing an existing login session. */
  oidcTransactionCookie(token: string): string {
    const secure = this.publicUrl.startsWith("https:") ? "; Secure" : "";
    return `nspanel_oidc=${token}; Path=/api/auth/sso/callback; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(oidcTransactionLifetimeMs / 1000)}${secure}`;
  }

  /** Clears the callback-scoped OIDC transaction cookie after success or failure. */
  clearOidcTransactionCookie(): string {
    const secure = this.publicUrl.startsWith("https:") ? "; Secure" : "";
    return `nspanel_oidc=; Path=/api/auth/sso/callback; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure}`;
  }

  private sessionToken(request: Request): string | undefined {
    const cookie = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("nspanel_session="));
    return cookie?.slice("nspanel_session=".length);
  }

  /** Compares a submitted onboarding secret with the fixed-length startup token in constant time. */
  private matchesInitialSetupToken(candidate: string): boolean {
    const expected = this.initialSetupToken;
    if (!expected) return false;
    const candidateBytes = Buffer.from(candidate, "utf8");
    const expectedBytes = Buffer.from(expected, "utf8");
    if (candidateBytes.length !== expectedBytes.length) return false;
    return timingSafeEqual(candidateBytes, expectedBytes);
  }

  private requireOidc(): OidcSettings {
    if (!this.oidcSettings) throw new Error("Single sign-on is not configured.");
    return this.oidcSettings;
  }

  private async discoverOidc(): Promise<oidc.Configuration> {
    const settings = this.requireOidc();
    if (!settings.configuration) {
      const discovery = settings.discovery ??= oidc.discovery(settings.issuerUrl, settings.clientId, { client_secret: settings.clientSecret });
      try {
        settings.configuration = await discovery;
      } finally {
        if (settings.discovery === discovery) settings.discovery = undefined;
      }
    }
    return settings.configuration;
  }

  private getLoginAttempt(remoteAddress: string): LoginAttempt {
    const now = Date.now();
    const existing = this.loginAttempts.get(remoteAddress);
    if (existing?.blockedUntil && existing.blockedUntil > now) return existing;
    if (existing && existing.windowEndsAt > now) return existing;
    if (existing?.inFlight) {
      existing.failures = 0;
      existing.windowEndsAt = now + loginWindowMs;
      existing.blockedUntil = 0;
      return existing;
    }
    if (!existing || existing.windowEndsAt <= now) {
      const next = { failures: 0, inFlight: 0, windowEndsAt: now + loginWindowMs, blockedUntil: 0 };
      this.loginAttempts.set(remoteAddress, next);
      return next;
    }
    return existing;
  }

  private recordFailedLogin(remoteAddress: string, attempt: LoginAttempt): void {
    attempt.failures += 1;
    if (attempt.failures >= maximumLoginFailures) attempt.blockedUntil = Date.now() + loginWindowMs;
    if (this.loginAttempts.size > 1000) {
      for (const [address, entry] of this.loginAttempts) {
        if (entry.inFlight === 0 && entry.windowEndsAt <= Date.now()) this.loginAttempts.delete(address);
      }
      while (this.loginAttempts.size > 1000) {
        const idleAddress = [...this.loginAttempts].find(([, entry]) => entry.inFlight === 0)?.[0];
        if (!idleAddress) break;
        this.loginAttempts.delete(idleAddress);
      }
    }
  }

  private toPublicUser(user: { id: string; email: string; enabled: boolean; createdAt: string; oidcIdentity?: unknown }): PublicUser {
    return { id: user.id, email: user.email, enabled: user.enabled, createdAt: user.createdAt, ssoLinked: Boolean(user.oidcIdentity) };
  }
}

/** Raised for any invalid local or SSO identity without exposing account existence. */
export class InvalidCredentialsError extends Error {}

/** Raised when repeated local login failures exceed the per-address allowance. */
export class LoginRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) { super("Too many sign-in attempts."); }
}

/** Raised when first-user setup is attempted without the runtime-generated onboarding token. */
export class InvalidInitialSetupTokenError extends Error {
  constructor() { super("A valid setup token is required."); }
}

/** Reads an HTTP(S) URL from a server-side setting and rejects embedded credentials. */
function parseHttpUrl(value: string, setting: string): URL {
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error(`${setting} must be an absolute HTTP or HTTPS URL.`); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
    throw new Error(`${setting} must be an absolute HTTP or HTTPS URL without embedded credentials or fragments.`);
  }
  return parsed;
}

/** Requires HTTPS for remote identity and public manager URLs, allowing loopback development hosts. */
function requireSecureUrl(url: URL, setting: string): void {
  if (url.protocol === "https:") return;
  const hostname = url.hostname.toLowerCase();
  const isLoopback = hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "[::1]";
  if (!isLoopback) throw new Error(`${setting} must use HTTPS unless it points to a loopback development host.`);
}
