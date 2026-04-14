import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { requireAdminAccess, resolveEffectiveUserId } from "../src/auth/index.js";

const ENV_KEYS = [
  "AUTH_REQUIRED",
  "AUTH_TRUSTED_USER_HEADER",
  "ADMIN_API_KEY",
  "ADMIN_API_KEY_HEADER",
];

const envSnapshot = new Map<string, string | undefined>();

function resetEnv(): void {
  for (const key of ENV_KEYS) {
    const value = envSnapshot.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

beforeEach(() => {
  envSnapshot.clear();
  for (const key of ENV_KEYS) {
    envSnapshot.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  resetEnv();
});

describe("request auth identity resolution", () => {
  it("uses a trusted header user id and blocks spoofed userId values", async () => {
    process.env.AUTH_REQUIRED = "true";
    process.env.AUTH_TRUSTED_USER_HEADER = "x-user-id";

    const app = new Hono();
    app.get("/", async (c) => {
      const identity = await resolveEffectiveUserId(c, c.req.query("userId") ?? undefined);
      if (!identity.ok) {
        return c.json({ error: identity.error }, identity.status);
      }
      return c.json({ userId: identity.userId });
    });

    const response = await app.request("http://local.test/?userId=spoofed-user", {
      headers: { "x-user-id": "real-user" },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Authenticated user does not match the requested userId",
    });
  });

  it("requires authentication when AUTH_REQUIRED is enabled", async () => {
    process.env.AUTH_REQUIRED = "true";

    const app = new Hono();
    app.get("/", async (c) => {
      const identity = await resolveEffectiveUserId(c, c.req.query("userId") ?? undefined);
      if (!identity.ok) {
        return c.json({ error: identity.error }, identity.status);
      }
      return c.json({ userId: identity.userId });
    });

    const response = await app.request("http://local.test/?userId=user-1");
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Authentication is required",
    });
  });

  it("allows admin-key authenticated callers through admin routes", async () => {
    process.env.ADMIN_API_KEY = "super-secret";

    const app = new Hono();
    app.get("/", async (c) => {
      const admin = await requireAdminAccess(c);
      if (!admin.ok) {
        return c.json({ error: admin.error }, admin.status);
      }
      return c.json({ ok: true });
    });

    const response = await app.request("http://local.test/", {
      headers: { "x-clawless-admin-key": "super-secret" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});
