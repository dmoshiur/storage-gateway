import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/errors";

vi.mock("server-only", () => ({}));

const createAdminSession = vi.fn();
const getSessionActorFromCookies = vi.fn();
const writeAuditLog = vi.fn();
const writeAuditLogSafely = vi.fn();
const recordAdminLogin = vi.fn();

vi.mock("@/lib/auth/session", () => ({
  SESSION_COOKIE_NAME: "ngo_gateway_session",
  SESSION_MAX_AGE_SECONDS: 60,
  createAdminSession,
  getSessionActorFromCookies,
}));
vi.mock("@/lib/firestore/audit", () => ({
  writeAuditLog,
  writeAuditLogSafely,
  auditActorFrom: (actor: { uid: string; email: string | null; type: "admin" }) => ({ uid: actor.uid, email: actor.email, type: actor.type }),
}));
vi.mock("@/lib/firestore/users", () => ({ recordAdminLogin }));

const sessionRoute = await import("@/app/api/auth/session/route");
const logoutRoute = await import("@/app/api/auth/logout/route");

function sameOriginRequest(url: string, init: RequestInit): Request {
  return new Request(url, {
    ...init,
    headers: {
      host: "gateway.test",
      origin: "https://gateway.test",
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

describe("admin session routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createAdminSession.mockResolvedValue({ cookie: "verified-session-cookie", actor: { uid: "admin-1", email: "admin@ngo.test", role: "admin", type: "admin" } });
    writeAuditLog.mockResolvedValue(undefined);
    writeAuditLogSafely.mockResolvedValue(undefined);
    recordAdminLogin.mockResolvedValue(undefined);
    getSessionActorFromCookies.mockResolvedValue({ uid: "admin-1", email: "admin@ngo.test", role: "admin", type: "admin" });
  });

  it("creates an HTTP-only server session after an authorized Firebase login", async () => {
    const response = await sessionRoute.POST(sameOriginRequest("https://gateway.test/api/auth/session", { method: "POST", body: JSON.stringify({ idToken: "x".repeat(200) }) }));
    expect(response.status).toBe(200);
    expect((await response.json()).data.actor.role).toBe("admin");
    expect(response.headers.get("set-cookie")).toContain("ngo_gateway_session=verified-session-cookie");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "LOGIN" }));
  });

  it("returns a safe authorization error and no session for an unauthorized login", async () => {
    createAdminSession.mockRejectedValueOnce(new ApiError(403, "ADMIN_REQUIRED", "This account is not authorized to access the storage gateway."));
    const response = await sessionRoute.POST(sameOriginRequest("https://gateway.test/api/auth/session", { method: "POST", body: JSON.stringify({ idToken: "x".repeat(200) }) }));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("ADMIN_REQUIRED");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("clears the session cookie and records logout", async () => {
    const response = await logoutRoute.POST(sameOriginRequest("https://gateway.test/api/auth/logout", { method: "POST", body: "{}" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toMatch(/ngo_gateway_session=.*Max-Age=0/i);
    expect(writeAuditLogSafely).toHaveBeenCalledWith(expect.objectContaining({ action: "LOGOUT" }));
  });
});
