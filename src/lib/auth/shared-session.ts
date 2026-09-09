import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { getAdminPass } from "@/lib/env";
import type { SessionActor } from "@/types/auth";

/**
 * Self-contained signed sessions for shared-passphrase sign-in.
 *
 * Firebase session cookies are JWTs, so their first dot-separated segment is
 * base64url JSON and can never equal the literal "sgp1" marker below. That makes
 * the marker a collision-free discriminator inside the single session cookie.
 */
const SHARED_SESSION_MARKER = "sgp1";
const SHARED_SESSION_VERSION = 1;
const SHARED_SESSION_KEY_CONTEXT = "ngo-gateway-shared-session-v1";
const CLOCK_SKEW_SECONDS = 60;

/** Stable identity for the shared-passphrase administrator. */
export const SHARED_PASS_ACTOR_UID = "shared-pass-admin";

interface SharedSessionPayload {
  v: number;
  uid: string;
  role: "admin";
  iat: number;
  exp: number;
}

export function sharedPassActor(): SessionActor {
  return { uid: SHARED_PASS_ACTOR_UID, email: null, role: "admin", type: "admin" };
}

/**
 * The signing key is derived from ADMIN_PASS with a context label, so the raw
 * passphrase is never used as key material. Rotating ADMIN_PASS immediately
 * invalidates every shared-passphrase session.
 */
function sharedSessionKey(): Buffer {
  return createHmac("sha256", getAdminPass()).update(SHARED_SESSION_KEY_CONTEXT).digest();
}

function sign(encodedPayload: string): Buffer {
  return createHmac("sha256", sharedSessionKey()).update(`${SHARED_SESSION_MARKER}.${encodedPayload}`).digest();
}

export function createSharedPassSession(maxAgeSeconds: number): { cookie: string; actor: SessionActor } {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload: SharedSessionPayload = {
    v: SHARED_SESSION_VERSION,
    uid: SHARED_PASS_ACTOR_UID,
    role: "admin",
    iat: issuedAt,
    exp: issuedAt + maxAgeSeconds,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const cookie = `${SHARED_SESSION_MARKER}.${encodedPayload}.${sign(encodedPayload).toString("base64url")}`;
  return { cookie, actor: sharedPassActor() };
}

/** Only `sgp1.*` values are shared sessions; everything else is treated as a Firebase cookie. */
export function isSharedSessionToken(value: string): boolean {
  return value.startsWith(`${SHARED_SESSION_MARKER}.`);
}

/** Returns the administrator actor for a valid token, or null for anything else. */
export function verifySharedPassSessionToken(value: string, maxAgeSeconds: number): SessionActor | null {
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== SHARED_SESSION_MARKER) return null;
  const expected = sign(parts[1]);
  const supplied = Buffer.from(parts[2], "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  let payload: SharedSessionPayload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as SharedSessionPayload;
  } catch {
    return null;
  }
  if (payload.v !== SHARED_SESSION_VERSION || payload.uid !== SHARED_PASS_ACTOR_UID || payload.role !== "admin") return null;
  const now = Math.floor(Date.now() / 1000);
  if (payload.iat > now + CLOCK_SKEW_SECONDS) return null;
  if (payload.exp <= now || payload.exp - payload.iat > maxAgeSeconds + CLOCK_SKEW_SECONDS) return null;
  return sharedPassActor();
}
