import type { Context } from "hono";
import type { RequestAuthContext } from "../runtime/request-context.js";
import { verifyJwt } from "./jwt.js";
import { envFlag, isDevelopmentMode, isProductionMode } from "../runtime/mode.js";

const authCache = new WeakMap<Request, Promise<RequestAuthContext>>();

function getClaimValue(claims: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = claims;

  for (const part of parts) {
    if (typeof current !== "object" || current === null || !(part in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

function hasConfiguredAuthProviders(): boolean {
  return Boolean(
    process.env.AUTH_TRUSTED_USER_HEADER ||
    process.env.AUTH_JWKS_URL ||
    process.env.AUTH_JWT_SECRET
  );
}

function hasAdminAccessConfigured(): boolean {
  return Boolean(process.env.ADMIN_API_KEY) || hasConfiguredAuthProviders();
}

function isAuthRequired(): boolean {
  if (process.env.AUTH_REQUIRED !== undefined) {
    return envFlag(process.env.AUTH_REQUIRED);
  }
  return isProductionMode();
}

function getAdminRoleValues(): string[] {
  return (process.env.AUTH_ADMIN_ROLE_VALUES ?? "service_role,admin")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

async function resolveRequestAuth(c: Context): Promise<RequestAuthContext> {
  const required = isAuthRequired();
  const adminKeyHeader = process.env.ADMIN_API_KEY_HEADER ?? "x-clawless-admin-key";
  const adminKey = process.env.ADMIN_API_KEY;
  const suppliedAdminKey = c.req.header(adminKeyHeader);

  if (adminKey && suppliedAdminKey && suppliedAdminKey === adminKey) {
    return {
      required,
      authenticated: true,
      isAdmin: true,
      source: "admin_key",
    };
  }

  const trustedUserHeader = process.env.AUTH_TRUSTED_USER_HEADER;
  if (trustedUserHeader) {
    const userId = c.req.header(trustedUserHeader);
    if (userId) {
      return {
        required,
        authenticated: true,
        isAdmin: false,
        source: "trusted_header",
        userId,
      };
    }
  }

  const authorization = c.req.header("Authorization");
  if (authorization?.startsWith("Bearer ")) {
    const token = authorization.slice(7).trim();
    const { claims } = await verifyJwt(token, {
      secret: process.env.AUTH_JWT_SECRET,
      jwksUrl: process.env.AUTH_JWKS_URL,
      issuer: process.env.AUTH_JWT_ISSUER,
      audience: process.env.AUTH_JWT_AUDIENCE,
    });

    const userClaim = process.env.AUTH_USER_ID_CLAIM ?? "sub";
    const userId = getClaimValue(claims, userClaim);
    if (typeof userId !== "string" || !userId) {
      throw new Error(`JWT user claim "${userClaim}" is missing or invalid`);
    }

    const adminClaimPath = process.env.AUTH_ADMIN_ROLE_CLAIM ?? "role";
    const adminClaim = getClaimValue(claims, adminClaimPath);
    const adminRoleValues = getAdminRoleValues();
    const isAdmin =
      typeof adminClaim === "string" && adminRoleValues.includes(adminClaim);

    return {
      required,
      authenticated: true,
      isAdmin,
      source: "jwt",
      userId,
      claims,
    };
  }

  return {
    required,
    authenticated: false,
    isAdmin: false,
    source: "none",
  };
}

export async function getRequestAuth(c: Context): Promise<RequestAuthContext> {
  const existing = authCache.get(c.req.raw);
  if (existing) return existing;

  const pending = resolveRequestAuth(c);
  authCache.set(c.req.raw, pending);
  return pending;
}

export async function requireAdminAccess(
  c: Context
): Promise<{ ok: true; auth: RequestAuthContext } | { ok: false; status: 401 | 403; error: string }> {
  if (isDevelopmentMode() && !hasAdminAccessConfigured()) {
    return { ok: true, auth: { required: false, authenticated: false, isAdmin: true, source: "none" } };
  }

  try {
    const auth = await getRequestAuth(c);
    if (auth.isAdmin) {
      return { ok: true, auth };
    }
    return { ok: false, status: auth.authenticated ? 403 : 401, error: "Admin access required" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 401, error: message };
  }
}

export async function resolveEffectiveUserId(
  c: Context,
  explicitUserId?: string
): Promise<{ ok: true; userId: string; auth: RequestAuthContext } | { ok: false; status: 400 | 401 | 403; error: string }> {
  let auth: RequestAuthContext;

  try {
    auth = await getRequestAuth(c);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 401, error: message };
  }

  if (auth.authenticated && auth.userId) {
    if (explicitUserId && explicitUserId !== auth.userId && !auth.isAdmin) {
      return { ok: false, status: 403, error: "Authenticated user does not match the requested userId" };
    }
    return { ok: true, userId: auth.isAdmin ? (explicitUserId ?? auth.userId) : auth.userId, auth };
  }

  if (auth.isAdmin && explicitUserId) {
    return { ok: true, userId: explicitUserId, auth };
  }

  if (auth.required) {
    return { ok: false, status: 401, error: "Authentication is required" };
  }

  if (!explicitUserId) {
    return { ok: false, status: 400, error: "userId is required" };
  }

  return { ok: true, userId: explicitUserId, auth };
}
