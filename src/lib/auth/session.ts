import "server-only";

import { cookies } from "next/headers";
import type { DecodedIdToken } from "firebase-admin/auth";
import { ApiError } from "@/lib/api/errors";
import { getAdminAuth } from "@/lib/firebase/admin";
import { getAdminEmails } from "@/lib/env";
import { can, type Capability } from "@/lib/auth/authorization";
import { resolveRoleFromIdentityClaims } from "@/lib/auth/login-policy";
import type { Role, SessionActor } from "@/types/auth";

export const SESSION_COOKIE_NAME = "ngo_gateway_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 5;

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
  } catch {
    throw new ApiError(401, "INVALID_ID_TOKEN", "Your sign-in could not be verified. Please sign in again.");
  }
  const actor = actorFromClaims(decoded);
  if (!can(actor.role, "manage_files")) {
    throw new ApiError(403, "ADMIN_REQUIRED", "This account is not authorized to access the storage gateway.");
  }
  const cookie = await auth.createSessionCookie(idToken, { expiresIn: SESSION_MAX_AGE_SECONDS * 1000 });
  return { cookie, actor };
}

export async function verifySessionCookie(value: string | undefined): Promise<SessionActor> {
  if (!value) throw new ApiError(401, "UNAUTHENTICATED", "Please sign in to continue.");
  try {
    const decoded = await getAdminAuth().verifySessionCookie(value, true);
    return actorFromClaims(decoded);
  } catch {
    throw new ApiError(401, "SESSION_EXPIRED", "Your session has expired. Please sign in again.");
  }
}

export async function getSessionActorFromCookies(): Promise<SessionActor | null> {
  const value = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (!value) return null;
  try {
    return await verifySessionCookie(value);
  } catch {
    return null;
  }
}

export async function requireAdminFromCookies(capability: Capability = "manage_files"): Promise<SessionActor> {
  const actor = await getSessionActorFromCookies();
  if (!actor) throw new ApiError(401, "UNAUTHENTICATED", "Please sign in to continue.");
  if (!can(actor.role, capability)) throw new ApiError(403, "FORBIDDEN", "You do not have permission to perform this action.");
  return actor;
}
