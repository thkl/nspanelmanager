import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import type { PublicUser } from "./auth.types.js";

interface StoredUser {
  id: string;
  email: string;
  passwordHash: string;
  enabled: boolean;
  createdAt: string;
  oidcIdentity?: { issuer: string; subject: string };
}

interface StoredSession {
  tokenHash: string;
  userId?: string;
  expiresAt: number;
  oidcTransaction?: { state: string; nonce: string; codeVerifier: string; expiresAt: number };
}

interface UserStoreSnapshot {
  version: 1;
  users: StoredUser[];
  sessions: StoredSession[];
}

/** Persists local accounts and revocable opaque sessions in one private file. */
export class UserStore {
  private readonly filePath: string;
  private snapshot: UserStoreSnapshot = { version: 1, users: [], sessions: [] };
  private writeQueue: Promise<void> = Promise.resolve();

  /** Creates the local account store under the configured manager data directory. */
  constructor(dataDir: string) { this.filePath = path.join(dataDir, "users.json"); }

  /** Loads accounts and sessions, creating an empty private store on first run. */
  async load(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(this.filePath), 0o700);
    try {
      const stored = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<UserStoreSnapshot>;
      if (stored.version !== 1 || !Array.isArray(stored.users) || !Array.isArray(stored.sessions) ||
        !stored.users.every(isStoredUser) || !stored.sessions.every(isStoredSession)) {
        throw new Error("The local user store is invalid; refusing to discard or replace account data.");
      }
      const emailKeys = stored.users.map((user) => user.email);
      const identityKeys = stored.users.flatMap((user) => user.oidcIdentity ? [`${user.oidcIdentity.issuer}\u0000${user.oidcIdentity.subject}`] : []);
      if (new Set(emailKeys).size !== emailKeys.length || new Set(stored.users.map((user) => user.id)).size !== stored.users.length ||
        new Set(identityKeys).size !== identityKeys.length) {
        throw new Error("The local user store contains duplicate account identifiers; refusing to load ambiguous access data.");
      }
      const userIds = new Set(stored.users.map((user) => user.id));
      if (stored.sessions.some((session) => session.userId && !userIds.has(session.userId))) {
        throw new Error("The local user store contains a session for a missing account; refusing to load ambiguous access data.");
      }
      await chmod(this.filePath, 0o600);
      this.snapshot = {
        version: 1,
        users: stored.users,
        sessions: stored.sessions
      };
      await this.expireSessions();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.persist();
    }
  }

  /** Returns all accounts without their password hashes. */
  listUsers(): PublicUser[] { return this.snapshot.users.map(toPublicUser); }

  /** Looks up an enabled or disabled account using its normalized email. */
  findByEmail(email: string): StoredUser | undefined {
    return this.snapshot.users.find((user) => user.email === normalizeEmail(email));
  }

  /** Looks up one account by stable local identifier. */
  findById(id: string): StoredUser | undefined { return this.snapshot.users.find((user) => user.id === id); }

  /** Finds the local account previously linked to an OIDC issuer and subject. */
  findByOidcIdentity(issuer: string, subject: string): StoredUser | undefined {
    return this.snapshot.users.find((user) => user.oidcIdentity?.issuer === issuer && user.oidcIdentity.subject === subject);
  }

  /** Creates a local administrator account after enforcing normalized email uniqueness. */
  async createUser(email: string, passwordHash: string): Promise<PublicUser> {
    const normalized = normalizeEmail(email);
    validateEmail(normalized);
    if (this.snapshot.users.some((user) => user.email === normalized)) throw new Error("An account with this email already exists.");
    return this.persistNewUser(normalized, passwordHash);
  }

  /** Creates the first administrator exactly once during unauthenticated setup. */
  async createInitialUser(email: string, passwordHash: string): Promise<PublicUser> {
    if (this.snapshot.users.length > 0) throw new InitialSetupCompletedError();
    const normalized = normalizeEmail(email);
    validateEmail(normalized);
    return this.persistNewUser(normalized, passwordHash);
  }

  /** Changes an account's password or enabled status and protects the final active administrator. */
  async updateUser(id: string, update: { passwordHash?: string; enabled?: boolean }): Promise<PublicUser | undefined> {
    const user = this.findById(id);
    if (!user) return undefined;
    if (update.enabled === false && user.enabled && this.snapshot.users.filter((item) => item.enabled).length <= 1) {
      throw new Error("The last enabled administrator cannot be disabled.");
    }
    if (update.passwordHash) user.passwordHash = update.passwordHash;
    if (typeof update.enabled === "boolean") user.enabled = update.enabled;
    if (update.passwordHash || !user.enabled) this.snapshot.sessions = this.snapshot.sessions.filter((session) => session.userId !== id);
    await this.persist();
    return toPublicUser(user);
  }

  /** Removes an account and its sessions unless it is the final enabled administrator. */
  async removeUser(id: string): Promise<boolean> {
    const user = this.findById(id);
    if (!user) return false;
    if (user.enabled && this.snapshot.users.filter((item) => item.enabled).length <= 1) {
      throw new Error("The last enabled administrator cannot be removed.");
    }
    this.snapshot.users = this.snapshot.users.filter((item) => item.id !== id);
    this.snapshot.sessions = this.snapshot.sessions.filter((session) => session.userId !== id);
    await this.persist();
    return true;
  }

  /** Associates an OIDC subject only when it is not already linked to another account. */
  async linkOidcIdentity(user: StoredUser, issuer: string, subject: string): Promise<void> {
    const linked = this.findByOidcIdentity(issuer, subject);
    if (linked && linked.id !== user.id) throw new Error("This SSO identity is already linked to another account.");
    if (user.oidcIdentity && (user.oidcIdentity.issuer !== issuer || user.oidcIdentity.subject !== subject)) {
      throw new Error("This local account is already linked to a different SSO identity.");
    }
    user.oidcIdentity = { issuer, subject };
    await this.persist();
  }

  /** Saves a short-lived OIDC transaction before redirecting to the identity provider. */
  async createOidcTransaction(token: string, transaction: NonNullable<StoredSession["oidcTransaction"]>): Promise<void> {
    this.snapshot.sessions = this.snapshot.sessions.filter((session) => session.expiresAt > Date.now());
    if (this.snapshot.sessions.filter((session) => session.oidcTransaction).length >= 1000) {
      throw new Error("Too many pending SSO sign-ins. Try again shortly.");
    }
    this.snapshot.sessions.push({ tokenHash: hashToken(token), expiresAt: transaction.expiresAt, oidcTransaction: transaction });
    await this.persist();
  }

  /** Consumes a valid OIDC transaction so authorization responses cannot be replayed. */
  async consumeOidcTransaction(token: string): Promise<StoredSession["oidcTransaction"] | undefined> {
    const tokenHash = hashToken(token);
    const session = this.snapshot.sessions.find((item) => item.tokenHash === tokenHash);
    this.snapshot.sessions = this.snapshot.sessions.filter((item) => item.tokenHash !== tokenHash);
    await this.persist();
    return session?.expiresAt && session.expiresAt > Date.now() ? session.oidcTransaction : undefined;
  }

  /** Issues a revocable authenticated session and returns its opaque browser token. */
  async createSession(userId: string, expiresAt: number): Promise<string> {
    const now = Date.now();
    this.snapshot.sessions = this.snapshot.sessions.filter((session) => session.expiresAt > now);
    const activeUserSessions = this.snapshot.sessions.filter((session) => session.userId === userId);
    for (const expiredByLimit of activeUserSessions.slice(0, Math.max(0, activeUserSessions.length - 49))) {
      this.snapshot.sessions = this.snapshot.sessions.filter((session) => session !== expiredByLimit);
    }
    const token = randomBytes(32).toString("hex");
    this.snapshot.sessions.push({ tokenHash: hashToken(token), userId, expiresAt });
    await this.persist();
    return token;
  }

  /** Resolves a browser token to an enabled user, deleting expired or invalid sessions. */
  async resolveSession(token: string): Promise<{ user: StoredUser; session: StoredSession } | undefined> {
    if (!/^[a-f0-9]{64}$/.test(token)) return undefined;
    const hash = hashToken(token);
    const session = this.snapshot.sessions.find((item) => item.tokenHash === hash);
    if (!session || !session.userId || session.expiresAt <= Date.now()) {
      if (session) await this.deleteSession(token);
      return undefined;
    }
    const user = this.findById(session.userId);
    if (!user?.enabled) {
      await this.deleteSession(token);
      return undefined;
    }
    return { user, session };
  }

  /** Revokes a browser session by hashing its presented token. */
  async deleteSession(token: string): Promise<void> {
    const tokenHash = hashToken(token);
    this.snapshot.sessions = this.snapshot.sessions.filter((session) => session.tokenHash !== tokenHash);
    await this.persist();
  }

  private async expireSessions(): Promise<void> {
    const valid = this.snapshot.sessions.filter((session) => session.expiresAt > Date.now());
    if (valid.length !== this.snapshot.sessions.length) {
      this.snapshot.sessions = valid;
      await this.persist();
    }
  }

  /** Adds a new account to memory and completes its durable write before returning. */
  private async persistNewUser(email: string, passwordHash: string): Promise<PublicUser> {
    const user: StoredUser = { id: randomUUID(), email, passwordHash, enabled: true, createdAt: new Date().toISOString() };
    this.snapshot.users.push(user);
    try {
      await this.persist();
    } catch (error) {
      this.snapshot.users = this.snapshot.users.filter((storedUser) => storedUser.id !== user.id);
      throw error;
    }
    return toPublicUser(user);
  }

  private persist(): Promise<void> {
    const data = `${JSON.stringify(this.snapshot, null, 2)}\n`;
    const write = async (): Promise<void> => {
      const temporaryPath = `${this.filePath}.tmp`;
      await writeFile(temporaryPath, data, { mode: 0o600 });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.filePath);
    };
    this.writeQueue = this.writeQueue.then(write, write);
    return this.writeQueue;
  }
}

/** Signals that one-time public setup has already created an administrator. */
export class InitialSetupCompletedError extends Error {
  constructor() { super("Initial setup has already been completed."); }
}

/** Normalizes login emails consistently before uniqueness checks and comparisons. */
export function normalizeEmail(email: string): string { return email.trim().toLowerCase(); }

/** Validates the basic shape and storage limit for an account email address. */
export function validateEmail(email: string): void {
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid email address.");
}

/** Converts stored account data to the credential-free API representation. */
function toPublicUser(user: StoredUser): PublicUser {
  return { id: user.id, email: user.email, enabled: user.enabled, createdAt: user.createdAt, ssoLinked: Boolean(user.oidcIdentity) };
}

function hashToken(token: string): string { return createHash("sha256").update(token).digest("hex"); }

function isStoredUser(value: unknown): value is StoredUser {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.email !== "string" ||
    typeof value.passwordHash !== "string" || typeof value.enabled !== "boolean" || typeof value.createdAt !== "string") return false;
  if (!value.id || normalizeEmail(value.email) !== value.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email) || value.email.length > 254 ||
    !(value.passwordHash.startsWith("$argon2id$") || value.passwordHash.startsWith("scrypt$")) || !Number.isFinite(Date.parse(value.createdAt))) return false;
  return value.oidcIdentity === undefined || (isRecord(value.oidcIdentity) &&
    typeof value.oidcIdentity.issuer === "string" && Boolean(value.oidcIdentity.issuer) &&
    typeof value.oidcIdentity.subject === "string" && Boolean(value.oidcIdentity.subject));
}

function isStoredSession(value: unknown): value is StoredSession {
  if (!isRecord(value) || typeof value.tokenHash !== "string" || !/^[a-f0-9]{64}$/.test(value.tokenHash) || typeof value.expiresAt !== "number") return false;
  if (value.userId !== undefined && typeof value.userId !== "string") return false;
  if (Boolean(value.userId) === Boolean(value.oidcTransaction)) return false;
  return value.oidcTransaction === undefined || (isRecord(value.oidcTransaction) &&
    typeof value.oidcTransaction.state === "string" && typeof value.oidcTransaction.nonce === "string" &&
    typeof value.oidcTransaction.codeVerifier === "string" && typeof value.oidcTransaction.expiresAt === "number" &&
    value.oidcTransaction.state.length >= 16 && value.oidcTransaction.nonce.length >= 16 &&
    value.oidcTransaction.codeVerifier.length >= 32 && value.oidcTransaction.expiresAt === value.expiresAt);
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
