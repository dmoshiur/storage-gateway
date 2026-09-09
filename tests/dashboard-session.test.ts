import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/shared-session", () => ({
  isSharedSessionToken: (value: string) => value?.startsWith("sgp1.") ?? false,
  verifySharedPassSessionToken: () => null,
  SHARED_PASS_ACTOR_UID: "shared-pass-admin",
}));

// Simulate the production Firebase scenario where the session cookie exists but
// the underlying user/session state can no longer be verified (expired, revoked,
// or the jwks/ESM issue is resolved but the token is stale).
vi.mock("@/lib/firebase/admin", () => ({
  getAdminAuth: () => ({
    verifySessionCookie: () => Promise.reject(new Error("Firebase session expired")),
  }),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: () => ({ value: "expired-firebase-session-cookie" }),
  })),
}));

vi.mock("@/lib/env", () => ({
  getAdminEmails: () => new Set<string>(),
}));

const { getSessionActorFromCookies } = await import("@/lib/auth/session");
const { cookies } = await import("next/headers");

describe("dashboard session initialization (no 500 on invalid state)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null instead of throwing when the session cookie cannot be verified", async () => {
    // Guards the dashboard entry path: an unverifiable cookie must resolve to a
    // signed-out state (redirect to /admin/login), never surface a 500.
    await expect(getSessionActorFromCookies()).resolves.toBeNull();
  });

  it("returns null when no session cookie exists yet (first visit)", async () => {
    vi.mocked(cookies).mockResolvedValueOnce({ get: () => undefined } as never);
    await expect(getSessionActorFromCookies()).resolves.toBeNull();
  });

  it("treats an empty cookie value like a missing session", async () => {
    vi.mocked(cookies).mockResolvedValueOnce({ get: () => ({ value: "" }) } as Awaited<ReturnType<typeof cookies>>);
    await expect(getSessionActorFromCookies()).resolves.toBeNull();
  });
});
