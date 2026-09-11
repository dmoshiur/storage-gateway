import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/errors";

vi.mock("server-only", () => ({}));

/**
 * Regression guard: an identity-provider failure must never be reported as an
 * expired session.
 *
 * `getAdminAuth()` throws a 503 SERVICE_CONFIGURATION_ERROR when the Firebase
 * Admin credentials are missing or malformed. Session verification used to catch
 * that and re-throw a 401, so a server misconfiguration reached the browser as
 * "Your session has expired. Please sign in again." and every dashboard module
 * failed at once while looking like a login problem.
 */
const h = vi.hoisted(() => ({
  /** When set, `getAdminAuth()` throws instead of returning an auth client. */
  adminInitFailure: null as (() => never) | null,
  verifySessionCookie: vi.fn(),
}));

vi.mock("@/lib/firebase/admin", () => ({
  getAdminAuth: () => {
    if (h.adminInitFailure) h.adminInitFailure();
    return { verifySessionCookie: h.verifySessionCookie };
  },
  getAdminDb: () => {
    throw new Error("not used");
  },
  getFirebaseAdminApp: () => {
    throw new Error("not used");
  },
}));

vi.mock("@/lib/auth/shared-session", () => ({
  isSharedSessionToken: (value: string) => value?.startsWith("sgp1.") ?? false,
  verifySharedPassSessionToken: () => null,
  SHARED_PASS_ACTOR_UID: "shared-pass-admin",
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => ({ value: "a-firebase-session-cookie" }) })),
}));

vi.mock("@/lib/env", () => ({ getAdminEmails: () => new Set<string>() }));

vi.mock("@/lib/firestore/users", () => ({
  listManagedUsers: vi.fn(async () => []),
  inviteUser: vi.fn(),
  recordAdminLogin: vi.fn(),
}));

const { verifySessionCookie, getSessionActorFromCookies } = await import("@/lib/auth/session");
const usersRoute = await import("@/app/api/users/route");

const configError = () => new ApiError(503, "SERVICE_CONFIGURATION_ERROR", "Missing server configuration for firebase: FIREBASE_PRIVATE_KEY.");

beforeEach(() => {
  h.adminInitFailure = null;
  h.verifySessionCookie.mockReset();
});

describe("session verification failure modes", () => {
  it("propagates a 503 configuration error instead of claiming the session expired", async () => {
    h.adminInitFailure = () => {
      throw configError();
    };
    await expect(verifySessionCookie("a-firebase-session-cookie")).rejects.toMatchObject({
      status: 503,
      code: "SERVICE_CONFIGURATION_ERROR",
    });
  });

  it("still reports a genuinely unverifiable cookie as an expired session", async () => {
    h.verifySessionCookie.mockRejectedValue(new Error("Firebase session expired"));
    await expect(verifySessionCookie("a-firebase-session-cookie")).rejects.toMatchObject({
      status: 401,
      code: "SESSION_EXPIRED",
    });
  });

  it("treats a missing cookie as unauthenticated, not as a server fault", async () => {
    await expect(verifySessionCookie(undefined)).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHENTICATED",
    });
  });
});

describe("dashboard session initialization", () => {
  it("resolves to null for a cookie the visitor can fix by signing in again", async () => {
    h.verifySessionCookie.mockRejectedValue(new Error("Firebase session expired"));
    await expect(getSessionActorFromCookies()).resolves.toBeNull();
  });

  it("propagates a 503 so the page reports an outage rather than silently signing out", async () => {
    h.adminInitFailure = () => {
      throw configError();
    };
    await expect(getSessionActorFromCookies()).rejects.toMatchObject({ status: 503 });
  });
});

describe("GET /api/users when the identity provider is misconfigured", () => {
  it("returns 503 SERVICE_CONFIGURATION_ERROR rather than 401 SESSION_EXPIRED", async () => {
    h.adminInitFailure = () => {
      throw configError();
    };
    const response = await usersRoute.GET(
      new Request("http://gateway.test/api/users", { headers: { cookie: "ngo_gateway_session=a-firebase-session-cookie" } }),
    );
    const body = (await response.json()) as { error: { code: string } };
    expect(response.status).toBe(503);
    expect(body.error.code).toBe("SERVICE_CONFIGURATION_ERROR");
  });

  it("still returns 401 when the session is genuinely invalid", async () => {
    h.verifySessionCookie.mockRejectedValue(new Error("Firebase session expired"));
    const response = await usersRoute.GET(
      new Request("http://gateway.test/api/users", { headers: { cookie: "ngo_gateway_session=a-firebase-session-cookie" } }),
    );
    const body = (await response.json()) as { error: { code: string } };
    expect(response.status).toBe(401);
    expect(body.error.code).toBe("SESSION_EXPIRED");
  });
});
