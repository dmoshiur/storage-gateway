import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
// Firebase Admin must never be reached for shared-pass tokens; make any call fail loudly.
vi.mock("@/lib/firebase/admin", () => ({ getAdminAuth: () => { throw new Error("Firebase Admin must not be used for shared sessions"); } }));

const { createSharedPassSession, isSharedSessionToken, verifySharedPassSessionToken, SHARED_PASS_ACTOR_UID } = await import("@/lib/auth/shared-session");
const { verifySessionCookie } = await import("@/lib/auth/session");

const MAX_AGE = 60 * 60 * 24 * 5;

describe("shared passphrase sessions", () => {
  const original = process.env.ADMIN_PASS;

  beforeAll(() => {
    process.env.ADMIN_PASS = "correct-admin-passphrase";
  });
  afterAll(() => {
    if (original === undefined) delete process.env.ADMIN_PASS;
    else process.env.ADMIN_PASS = original;
  });

  it("round-trips a created session token to the shared administrator actor", () => {
    const { cookie, actor } = createSharedPassSession(MAX_AGE);
    expect(actor).toEqual({ uid: SHARED_PASS_ACTOR_UID, email: null, role: "admin", type: "admin" });
    expect(isSharedSessionToken(cookie)).toBe(true);
    expect(verifySharedPassSessionToken(cookie, MAX_AGE)).toEqual(actor);
  });

  it("is accepted by the shared verifySessionCookie dispatcher without Firebase Admin", async () => {
    const { cookie, actor } = createSharedPassSession(MAX_AGE);
    await expect(verifySessionCookie(cookie)).resolves.toEqual(actor);
  });

  it("does not mistake a Firebase-style JWT for a shared session token", () => {
    const firebaseLike = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJl";
    expect(isSharedSessionToken(firebaseLike)).toBe(false);
    expect(verifySharedPassSessionToken(firebaseLike, MAX_AGE)).toBeNull();
  });

  it("rejects a tampered payload even when the signature is preserved", () => {
    const { cookie } = createSharedPassSession(MAX_AGE);
    const [marker, payload, signature] = cookie.split(".");
    const tampered = Buffer.from(JSON.stringify({ v: 1, uid: "someone-else", role: "admin", iat: 0, exp: 9999999999 })).toString("base64url");
    expect(verifySharedPassSessionToken(`${marker}.${tampered}.${signature}`, MAX_AGE)).toBeNull();
    expect(verifySharedPassSessionToken(`${marker}.${payload}.${tampered}`, MAX_AGE)).toBeNull();
  });

  it("invalidates every shared session when ADMIN_PASS is rotated", () => {
    const { cookie } = createSharedPassSession(MAX_AGE);
    process.env.ADMIN_PASS = "rotated-admin-passphrase";
    expect(verifySharedPassSessionToken(cookie, MAX_AGE)).toBeNull();
    process.env.ADMIN_PASS = "correct-admin-passphrase";
  });

  it("rejects expired sessions and sessions longer than the allowed maximum age", () => {
    expect(verifySharedPassSessionToken(createSharedPassSession(-10).cookie, MAX_AGE)).toBeNull();
    expect(verifySharedPassSessionToken(createSharedPassSession(MAX_AGE * 10).cookie, MAX_AGE)).toBeNull();
  });

  it("rejects malformed values without throwing", () => {
    expect(verifySharedPassSessionToken("", MAX_AGE)).toBeNull();
    expect(verifySharedPassSessionToken("sgp1", MAX_AGE)).toBeNull();
    expect(verifySharedPassSessionToken("sgp1.only-two", MAX_AGE)).toBeNull();
    expect(verifySharedPassSessionToken("sgp1.@@@.!!!", MAX_AGE)).toBeNull();
  });
});
