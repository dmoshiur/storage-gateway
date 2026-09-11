import "server-only";

import { cookies } from "next/headers";
import type { DecodedIdToken } from "firebase-admin/auth";
import { ApiError, isApiError } from "@/lib/api/errors";
import { getAdminAuth } from "@/lib/firebase/admin";
import { getAdminEmails } from "@/lib/env";
import { can, type Capability } from "@/lib/auth/authorization";
import { isSharedSessionToken, verifySharedPassSessionToken } from "@/lib/auth/shared-session";
import { resolveRoleFromIdentityClaims } from "@/lib/auth/login-policy";
import type { Role, SessionActor } from "@/types/auth";

export const SESSION_COOKIE_NAME = "ngo_gateway_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 5;

/**
 * An identity-provider outage is not an expired session.
 *
 * `getAdminAuth()` throws a 503 `SERVICE_CONFIGURATION_ERROR` when the Firebase
 * Admin credentials are missing or malformed. Every caller below used to wrap
 * that in a bare `catch` and re-throw it as a 401, so a server-side
 * misconfiguration reached the browser as "Your session has expired. Please
 * sign in again." — every dashboard module then failed at once while looking
 * like a login problem, and re-authenticating could never fix it.
 *
 * Server-side failures (any 5xx `ApiError`) propagate untouched so the caller
 * returns an actionable 503. Only genuine credential failures become 401.
 */
function rethrowServerFailure(error: unknown): void {
  if (isApiError(error) && error.status >= 500) throw error;
}

type ClaimsWithRoles = Pick<DecodedIdToken, "email"> & { role?: unknown; roles?: unknown };

export function roleFromClaims(decoded: ClaimsWithRoles): Role {
  return resolveRoleFromIdentityClaims(decoded, getAdminEmails());
}

export function actorFromClaims(decoded: DecodedIdToken): SessionActor {
  return {
    uid: decoded.uid,
    email: decoded.email ?? null,
    role: roleFromClaims(decoded),
    type: "admin",
  };
}

export async function createAdminSession(idToken: string): Promise<{ cookie: string; actor: SessionActor }> {
  const auth = getAdminAuth();
  let decoded: DecodedIdToken;
  try {
    decoded = await auth.verifyIdToken(idToken, true);
  } catch (error) {
    rethrowServerFailure(error);
    throw new ApiError(401, "INVALID_ID_TOKEN", "Your sign-in could not be verified. Please sign in again.");
  }
  const actor = actorFromClaims(decoded);
  // Every user provisioned in Firebase Authentication may sign in; the resolved
  // role decides what each dashboard route lets them do.
  if (!can(actor.role, "read_files")) {
    throw new ApiError(403, "ACCOUNT_NOT_PERMITTED", "This account is not permitted to sign in to the storage gateway.");
  }
  let cookie: string;
  try {
    cookie = await auth.createSessionCookie(idToken, { expiresIn: SESSION_MAX_AGE_SECONDS * 1000 });
  } catch (error) {
    rethrowServerFailure(error);
    // Minting the cookie failed even though the token verified: that is a
    // dependency problem, not bad credentials, so it must not read as a 401.
    throw new ApiError(503, "SESSION_ISSUE_FAILED", "Sign-in is temporarily unavailable. Please retry in a moment.");
  }
  return { cookie, actor };
}

export async function verifySessionCookie(value: string | undefined): Promise<SessionActor> {
  if (!value) throw new ApiError(401, "UNAUTHENTICATED", "Please sign in to continue.");
  if (isSharedSessionToken(value)) {
    // Throws a 503 when ADMIN_PASS is unset — a configuration fault that must
    // surface as such, not as an expired session.
    const actor = verifySharedPassSessionToken(value, SESSION_MAX_AGE_SECONDS);
    if (!actor) throw new ApiError(401, "SESSION_EXPIRED", "Your session has expired. Please sign in again.");
    return actor;
  }
  let decoded: DecodedIdToken;
  try {
    decoded = await getAdminAuth().verifySessionCookie(value, true);
  } catch (error) {
    rethrowServerFailure(error);
    throw new ApiError(401, "SESSION_EXPIRED", "Your session has expired. Please sign in again.");
  }
  return actorFromClaims(decoded);
}

/**
 * Session actor for server-rendered pages.
 *
 * Resolves to `null` for anything a visitor can fix by signing in again (no
 * cookie, expired, revoked, malformed) so the dashboard degrades to the login
 * redirect instead of a 500. A server-side configuration failure is *not*
 * something re-authenticating can fix, so it propagates as a 503.
 */
export async function getSessionActorFromCookies(): Promise<SessionActor | null> {
  const value = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (!value) return null;
  try {
    return await verifySessionCookie(value);
  } catch (error) {
    rethrowServerFailure(error);
    return null;
  }
}

export async function requireAdminFromCookies(capability: Capability = "manage_files"): Promise<SessionActor> {
  const actor = await getSessionActorFromCookies();
  if (!actor) throw new ApiError(401, "UNAUTHENTICATED", "Please sign in to continue.");
  if (!can(actor.role, capability)) throw new ApiError(403, "FORBIDDEN", "You do not have permission to perform this action.");
  return actor;
}
