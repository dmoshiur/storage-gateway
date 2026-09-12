import "server-only";

import { cookies } from "next/headers";
import { createHash, randomBytes } from "node:crypto";
import { ApiError, isApiError } from "@/lib/api/errors";
import { query, toDate, SQL_NOW } from "@/lib/db/client";
import { actorFromUser, getUserForAuth, type AuthUserRow, recordAdminLogin, upgradePasswordHash } from "@/lib/db/users";
import { needsRehash, verifyPassword } from "@/lib/auth/password";
import { logger } from "@/lib/logging/logger";
import { can, type Capability } from "@/lib/auth/authorization";
import type { SessionActor } from "@/types/auth";

export const SESSION_COOKIE_NAME = "storage_gateway_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function clientIp(ip?: string | null): string | null {
  if (!ip) return null;
  return ip.slice(0, 64);
}

export function cookieOptions(maxAge = SESSION_MAX_AGE_SECONDS) {
  return {
    name: SESSION_COOKIE_NAME,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}

export async function createUserSession(
  user: AuthUserRow,
  metadata: { ip?: string | null; userAgent?: string | null } = {},
): Promise<{ cookie: string; actor: SessionActor }> {
  const token = randomBytes(32).toString("base64url");
  await query(
    `INSERT INTO sessions(user_id, token_hash, ip_address, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [user.id, tokenHash(token), clientIp(metadata.ip), metadata.userAgent?.slice(0, 500) ?? null, new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000)],
  );
  await recordAdminLogin(actorFromUser(user));
  return { cookie: token, actor: actorFromUser(user) };
}

export async function authenticateUser(
  email: string,
  password: string,
  metadata: { ip?: string | null; userAgent?: string | null } = {},
): Promise<{ cookie: string; actor: SessionActor }> {
  const user = await getUserForAuth(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    // One generic message for both "no such account" and "wrong password" so
    // the endpoint cannot be used to enumerate registered email addresses.
    throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid email or password.");
  }
  if (user.disabled) throw new ApiError(403, "ACCOUNT_DISABLED", "This account has been disabled. Contact an administrator.");

  // Transparently upgrade hashes written under weaker scrypt parameters. The
  // password is already verified here; a failure must not block the sign-in.
  if (needsRehash(user.password_hash)) {
    try {
      await upgradePasswordHash(user.id, password);
    } catch (error) {
      logger.warn("Password hash upgrade failed", {
        userId: user.id,
        error: error instanceof Error ? error.message : "unknown",
      });
    }
  }
  return createUserSession(user, metadata);
}

async function verifySessionToken(value: string | undefined): Promise<SessionActor> {
  if (!value) throw new ApiError(401, "UNAUTHENTICATED", "Please sign in to continue.");
  const result = await query<{
    id: string;
    user_id: string;
    email: string;
    role: string;
    disabled: boolean;
    expires_at: Date;
  }>(
    `SELECT s.id, s.user_id, u.email, u.role, u.disabled, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > ${SQL_NOW} AND u.deleted_at IS NULL
     LIMIT 1`,
    [tokenHash(value)],
  );
  const session = result.rows[0];
  if (!session || session.disabled) throw new ApiError(401, "SESSION_EXPIRED", "Your session has expired. Please sign in again.");
  await query(`UPDATE sessions SET last_used_at = ${SQL_NOW} WHERE id = $1`, [session.id]);
  return { uid: session.user_id, email: session.email, role: session.role === "admin" || session.role === "editor" || session.role === "viewer" ? session.role : "viewer", type: "admin" };
}

export async function verifySessionCookie(value: string | undefined): Promise<SessionActor> {
  return verifySessionToken(value);
}

export async function getSessionActorFromCookies(): Promise<SessionActor | null> {
  const value = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (!value) return null;
  try {
    return await verifySessionToken(value);
  } catch (error) {
    if (isApiError(error) && error.status >= 500) throw error;
    return null;
  }
}

export async function revokeSession(value: string | undefined): Promise<void> {
  if (!value) return;
  await query(`UPDATE sessions SET revoked_at = ${SQL_NOW} WHERE token_hash = $1 AND revoked_at IS NULL`, [tokenHash(value)]);
}

export async function revokeAllUserSessions(uid: string): Promise<void> {
  await query(`UPDATE sessions SET revoked_at = ${SQL_NOW} WHERE user_id = $1 AND revoked_at IS NULL`, [uid]);
}

export async function requireAdminFromCookies(capability: Capability = "manage_files"): Promise<SessionActor> {
  const actor = await getSessionActorFromCookies();
  if (!actor) throw new ApiError(401, "UNAUTHENTICATED", "Please sign in to continue.");
  if (!can(actor.role, capability)) throw new ApiError(403, "FORBIDDEN", "You do not have permission to perform this action.");
  return actor;
}

export function sessionExpiry(value: unknown): string | null {
  return toDate(value)?.toISOString() ?? null;
}
