import { Router, type RequestHandler } from "express";
import { AuthService, InvalidCredentialsError, InvalidInitialSetupTokenError, LoginRateLimitError } from "./auth-service.js";
import { InitialSetupCompletedError } from "./user-store.js";
import type { Logger } from "../../services/logger.js";

/** Creates local login, OIDC callback, logout, and protected account-management endpoints. */
export function createAuthRouter(auth: AuthService, logger: Logger): Router {
  const router = Router();
  router.use((_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });

  router.get("/status", async (request, response, next) => {
    try { response.json(await auth.status(request)); }
    catch (error) { next(error); }
  });

  router.post("/setup", async (request, response, next) => {
    try {
      const result = await auth.createInitialUser(
        stringValue(request.body?.email),
        stringValue(request.body?.password),
        stringValue(request.body?.bootstrapToken)
      );
      response.setHeader("Set-Cookie", auth.sessionCookie(result.token));
      response.status(201).json({ user: result.user });
    } catch (error) {
      if (error instanceof InitialSetupCompletedError) response.status(409).json({ error: error.message });
      else if (error instanceof InvalidInitialSetupTokenError) response.status(403).json({ error: error.message });
      else if (error instanceof Error && (error.message.startsWith("Enter a valid email") || error.message.startsWith("Passwords must contain"))) {
        response.status(400).json({ error: error.message });
      } else next(error);
    }
  });

  router.post("/login", async (request, response, next) => {
    try {
      const email = stringValue(request.body?.email);
      const password = stringValue(request.body?.password);
      const result = await auth.login(email, password, request.ip || request.socket.remoteAddress || "unknown");
      response.setHeader("Set-Cookie", auth.sessionCookie(result.token));
      response.json({ user: result.user });
    } catch (error) {
      if (error instanceof LoginRateLimitError) {
        response.setHeader("Retry-After", String(error.retryAfterSeconds));
        response.status(429).json({ error: error.message });
      } else if (error instanceof InvalidCredentialsError) response.status(401).json({ error: "Email or password is incorrect." });
      else next(error);
    }
  });

  router.post("/sso/start", async (_request, response) => {
    logger.debug("Received a request to start OIDC sign-in.", { component: "auth", phase: "sso-start" });
    try {
      const result = await auth.beginSsoLogin();
      response.setHeader("Set-Cookie", auth.oidcTransactionCookie(result.token));
      response.json({ authorizationUrl: result.url });
    } catch (error) {
      const detail = error instanceof Error ? error.message || error.name : String(error);
      if (error instanceof Error && error.message === "Single sign-on is not configured.") {
        logger.warn("OIDC sign-in was requested, but SSO is not configured.", { component: "auth", phase: "sso-start" });
        response.status(404).json({ error: error.message });
      } else {
        logger.error("Could not start OIDC sign-in.", { component: "auth", phase: "sso-start", detail });
        response.status(502).json({ error: "Could not contact the identity provider. Check the API server log for details." });
      }
    }
  });

  router.get("/sso/callback", async (request, response) => {
    const transactionToken = cookieValue(request, "nspanel_oidc");
    if (!transactionToken) {
      response.setHeader("Set-Cookie", auth.clearOidcTransactionCookie());
      response.redirect("/?login=sso-failed");
      return;
    }
    try {
      const currentUrl = new URL(request.originalUrl, auth.getOidcRedirectUrl());
      const result = await auth.completeSsoLogin(transactionToken, currentUrl);
      response.setHeader("Set-Cookie", [auth.clearOidcTransactionCookie(), auth.sessionCookie(result.token)]);
      response.redirect("/");
    } catch {
      response.setHeader("Set-Cookie", auth.clearOidcTransactionCookie());
      response.redirect("/?login=sso-failed");
    }
  });

  router.post("/logout", async (request, response, next) => {
    try {
      await auth.logout(request);
      response.setHeader("Set-Cookie", auth.clearSessionCookie());
      response.status(204).end();
    } catch (error) { next(error); }
  });

  router.get("/users", requireAuthenticatedUser(auth), (_request, response) => response.json({ users: auth.listUsers() }));
  router.post("/users", requireAuthenticatedUser(auth), async (request, response) => {
    try {
      const user = await auth.createUser(stringValue(request.body?.email), stringValue(request.body?.password));
      response.status(201).json({ user });
    } catch (error) { response.status(400).json({ error: message(error) }); }
  });
  router.put("/users/:id", requireAuthenticatedUser(auth), async (request, response) => {
    const update = request.body as { password?: unknown; enabled?: unknown } | undefined;
    const password = typeof update?.password === "string" && update.password ? update.password : undefined;
    const enabled = typeof update?.enabled === "boolean" ? update.enabled : undefined;
    if (!password && enabled === undefined) return response.status(400).json({ error: "Provide a new password or enabled status." });
    const userId = String(request.params.id);
    if (request.authUser?.id === userId && enabled === false) return response.status(400).json({ error: "You cannot disable your own account." });
    try {
      const user = await auth.updateUser(userId, { ...(password ? { password } : {}), ...(enabled === undefined ? {} : { enabled }) });
      return user ? response.json({ user }) : response.status(404).json({ error: "User not found." });
    } catch (error) { return response.status(400).json({ error: message(error) }); }
  });
  router.delete("/users/:id", requireAuthenticatedUser(auth), async (request, response) => {
    const userId = String(request.params.id);
    if (request.authUser?.id === userId) return response.status(400).json({ error: "You cannot remove your own account." });
    try {
      const removed = await auth.removeUser(userId);
      return removed ? response.status(204).end() : response.status(404).json({ error: "User not found." });
    } catch (error) { return response.status(400).json({ error: message(error) }); }
  });

  return router;
}

/** Rejects API mutations from origins outside the configured manager origin. */
export function requireSameOrigin(publicUrl: string): RequestHandler {
  let configuredOrigin: string | undefined;
  if (publicUrl) configuredOrigin = new URL(publicUrl).origin;
  return (request, response, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return next();
    const origin = request.get("origin");
    if (!origin) return response.status(403).json({ error: "A same-origin request is required." });
    try {
      const parsedOrigin = new URL(origin);
      const allowed = configuredOrigin ? parsedOrigin.origin === configuredOrigin : parsedOrigin.host === request.get("host");
      if (!allowed) return response.status(403).json({ error: "A same-origin request is required." });
      return next();
    } catch { return response.status(403).json({ error: "A same-origin request is required." }); }
  };
}

/** Resolves the opaque session token and stops protected account routes without a live user. */
export function requireAuthenticatedUser(auth: AuthService): RequestHandler {
  return async (request, response, next) => {
    try {
      const user = await auth.currentUser(request);
      if (!user) return response.status(401).json({ error: "Sign in to continue." });
      return next();
    } catch (error) { return next(error); }
  };
}

function cookieValue(request: { headers: { cookie?: string } }, name: string): string | undefined {
  const prefix = `${name}=`;
  const cookie = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
  return cookie?.slice(prefix.length);
}

function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }
function message(error: unknown): string { return error instanceof Error ? error.message : "The request could not be completed."; }
