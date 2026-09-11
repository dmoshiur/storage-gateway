import "server-only";

import { ApiError } from "@/lib/api/errors";
import { query, toDate, SQL_NOW } from "@/lib/db/client";
import { hashPassword, generateTemporaryPassword } from "@/lib/auth/password";
import type { Role, SessionActor } from "@/types/auth";
import { isValidRole } from "@/lib/auth/authorization";

export interface ManagedUser {
  uid: string;
  email: string;
  displayName: string | null;
  role: Role;
  disabled: boolean;
  createdAt: string | null;
  lastLoginAt: string | null;
}

export interface AuthUserRow {
  id: string;
  email: string;
  display_name: string | null;
  role: Role;
  disabled: boolean;
  password_hash: string;
  last_login_at: Date | null;
}

function role(value: unknown): Role {
  return isValidRole(value) ? value : "viewer";
}

function managed(row: Record<string, unknown>): ManagedUser {
  return {
    uid: String(row.id),
    email: String(row.email),
    displayName: typeof row.display_name === "string" ? row.display_name : null,
    role: role(row.role),
    disabled: Boolean(row.disabled),
    createdAt: toDate(row.created_at)?.toISOString() ?? null,
    lastLoginAt: toDate(row.last_login_at)?.toISOString() ?? null,
  };
}

export function actorFromUser(row: Pick<AuthUserRow, "id" | "email" | "role">): SessionActor {
  return { uid: row.id, email: row.email, role: role(row.role), type: "admin" };
}

export async function getUserForAuth(email: string): Promise<AuthUserRow | null> {
  const result = await query<AuthUserRow>(
    `SELECT id, email, display_name, role, disabled, password_hash, last_login_at
     FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL LIMIT 1`,
    [email.trim().toLowerCase()],
  );
  return result.rows[0] ?? null;
}

export async function getUserById(uid: string): Promise<AuthUserRow | null> {
  const result = await query<AuthUserRow>(
    `SELECT id, email, display_name, role, disabled, password_hash, last_login_at
     FROM users WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
    [uid],
  );
  return result.rows[0] ?? null;
}

export async function recordAdminLogin(actor: SessionActor): Promise<void> {
  await query(
    `UPDATE users SET last_login_at = ${SQL_NOW}, updated_at = ${SQL_NOW} WHERE id = $1 AND deleted_at IS NULL`,
    [actor.uid],
  );
}

export async function listManagedUsers(limit = 100): Promise<ManagedUser[]> {
  const result = await query(
    `SELECT id, email, display_name, role, disabled, created_at, last_login_at
     FROM users WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT $1`,
    [Math.min(Math.max(Math.trunc(limit), 1), 1000)],
  );
  return result.rows.map((row) => managed(row));
}

export async function inviteUser(input: {
  email: string;
  role: Role;
  displayName?: string;
  password?: string;
}): Promise<ManagedUser & { temporaryPassword?: string }> {
  const email = input.email.trim().toLowerCase();
  if (!isValidRole(input.role)) throw new ApiError(400, "INVALID_ROLE", "The selected role is invalid.");
  const temporaryPassword = input.password ? undefined : generateTemporaryPassword();
  const password = input.password ?? temporaryPassword!;
  if (password.length < 12) throw new ApiError(400, "WEAK_PASSWORD", "Passwords must be at least 12 characters long.");
  const existing = await query(`SELECT id FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL LIMIT 1`, [email]);
  if (existing.rowCount) throw new ApiError(409, "USER_EXISTS", "A user with that email address already exists.");
  try {
    const result = await query(
      `INSERT INTO users(email, password_hash, display_name, role, email_verified_at)
       VALUES ($1, $2, $3, $4, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       RETURNING id, email, display_name, role, disabled, created_at, last_login_at`,
      [email, hashPassword(password), input.displayName?.trim() || null, input.role],
    );
    return { ...managed(result.rows[0]!), ...(temporaryPassword ? { temporaryPassword } : {}) };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if ((error as { code?: string }).code === "23505") {
      throw new ApiError(409, "USER_EXISTS", "A user with that email address already exists.");
    }
    throw error;
  }
}

export async function setUserRole(uid: string, nextRole: Role): Promise<void> {
  if (!isValidRole(nextRole)) throw new ApiError(400, "INVALID_ROLE", "The selected role is invalid.");
  const result = await query(`UPDATE users SET role = $2, updated_at = ${SQL_NOW} WHERE id = $1 AND deleted_at IS NULL`, [uid, nextRole]);
  if (!result.rowCount) throw new ApiError(404, "USER_NOT_FOUND", "The user was not found.");
  await revokeUserSessions(uid);
}

export async function setUserDisabled(uid: string, disabled: boolean): Promise<void> {
  const result = await query(`UPDATE users SET disabled = $2, updated_at = ${SQL_NOW} WHERE id = $1 AND deleted_at IS NULL`, [uid, disabled]);
  if (!result.rowCount) throw new ApiError(404, "USER_NOT_FOUND", "The user was not found.");
  if (disabled) await revokeUserSessions(uid);
}

export async function resetUserPassword(uid: string, password?: string): Promise<{ temporaryPassword?: string }> {
  const temporaryPassword = password ? undefined : generateTemporaryPassword();
  const next = password ?? temporaryPassword!;
  if (next.length < 12) throw new ApiError(400, "WEAK_PASSWORD", "Passwords must be at least 12 characters long.");
  const result = await query(`UPDATE users SET password_hash = $2, updated_at = ${SQL_NOW} WHERE id = $1 AND deleted_at IS NULL`, [uid, hashPassword(next)]);
  if (!result.rowCount) throw new ApiError(404, "USER_NOT_FOUND", "The user was not found.");
  await revokeUserSessions(uid);
  return temporaryPassword ? { temporaryPassword } : {};
}

export async function revokeUserSessions(uid: string): Promise<number> {
  const result = await query(`UPDATE sessions SET revoked_at = ${SQL_NOW} WHERE user_id = $1 AND revoked_at IS NULL`, [uid]);
  return result.rowCount ?? 0;
}

export async function deleteUser(uid: string): Promise<void> {
  const result = await query(`UPDATE users SET deleted_at = ${SQL_NOW}, disabled = true, updated_at = ${SQL_NOW} WHERE id = $1 AND deleted_at IS NULL`, [uid]);
  if (!result.rowCount) throw new ApiError(404, "USER_NOT_FOUND", "The user was not found.");
  await revokeUserSessions(uid);
}

export async function listUserActivity(uid: string, limit = 100): Promise<unknown[]> {
  const result = await query(
    `SELECT id, action, actor_id AS "actorId", actor_email AS "actorEmail", actor_type AS "actorType",
            file_id AS "fileId", file_name AS "fileName", details, request_id AS "requestId", created_at AS "createdAt"
     FROM audit_logs WHERE actor_id = $1 OR json_extract(details, '$.userId') = $1 ORDER BY created_at DESC LIMIT $2`,
    [uid, Math.min(Math.max(Math.trunc(limit), 1), 500)],
  );
  return result.rows;
}

export async function pruneExpiredAuthData(): Promise<number> {
  const nowIso = new Date().toISOString();
  const staleBefore = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const sessions = await query(`DELETE FROM sessions WHERE expires_at < $1 OR (revoked_at IS NOT NULL AND revoked_at < $2)`, [nowIso, staleBefore]);
  const resetTokens = await query(`DELETE FROM password_reset_tokens WHERE expires_at < $1 OR used_at < $2`, [nowIso, staleBefore]);
  return (sessions.rowCount ?? 0) + (resetTokens.rowCount ?? 0);
}

/** Used by bootstrap checks without exposing a password. */
export async function countUsers(): Promise<number> {
  const result = await query<{ count: string }>(`SELECT count(*) AS count FROM users WHERE deleted_at IS NULL`);
  return Number(result.rows[0]?.count ?? 0);
}
