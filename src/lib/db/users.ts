import "server-only";

import { ApiError, isApiError } from "@/lib/api/errors";
import { query, toDate, SQL_NOW } from "@/lib/db/client";
import { hashPassword, generateTemporaryPassword } from "@/lib/auth/password";
import { checkPasswordPolicy } from "@/lib/auth/password-policy";
import type { Role, SessionActor } from "@/types/auth";
import { isValidRole } from "@/lib/auth/authorization";

/** Lifecycle state of an account, derived in SQL from `disabled`/`deleted_at`. */
export type UserStatus = "active" | "disabled" | "deleted";

/** Message shown whenever an email is already taken. Defined once so the API,
 *  the audit trail and the tests cannot drift apart. */
export const DUPLICATE_EMAIL_MESSAGE = "An account with this email already exists.";

export interface ManagedUser {
  uid: string;
  email: string;
  displayName: string | null;
  role: Role;
  status: UserStatus;
  disabled: boolean;
  createdAt: string | null;
  updatedAt: string | null;
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

/**
 * Reads the generated `status` column, falling back to the same derivation in
 * TypeScript so a database that has not yet run migration 002 still returns a
 * correct value instead of `undefined`.
 */
function status(row: Record<string, unknown>): UserStatus {
  const value = row.status;
  if (value === "active" || value === "disabled" || value === "deleted") return value;
  if (row.deleted_at) return "deleted";
  return row.disabled ? "disabled" : "active";
}

/** Columns every user-facing query selects, matching the ManagedUser contract. */
const MANAGED_COLUMNS = "id, email, display_name, role, status, disabled, created_at, updated_at, last_login_at";

function managed(row: Record<string, unknown>): ManagedUser {
  return {
    uid: String(row.id),
    email: String(row.email),
    displayName: typeof row.display_name === "string" ? row.display_name : null,
    role: role(row.role),
    status: status(row),
    disabled: Boolean(row.disabled),
    createdAt: toDate(row.created_at)?.toISOString() ?? null,
    updatedAt: toDate(row.updated_at)?.toISOString() ?? null,
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

/**
 * Replaces a stored hash that was produced with weaker-than-current scrypt
 * parameters. Called after the password has already been verified, so the
 * plaintext is known-good; failures are non-fatal because the existing hash
 * still authenticates the user.
 */
export async function upgradePasswordHash(uid: string, password: string): Promise<void> {
  await query(
    `UPDATE users SET password_hash = $2, updated_at = ${SQL_NOW} WHERE id = $1 AND deleted_at IS NULL`,
    [uid, hashPassword(password)],
  );
}

export async function recordAdminLogin(actor: SessionActor): Promise<void> {
  await query(
    `UPDATE users SET last_login_at = ${SQL_NOW}, updated_at = ${SQL_NOW} WHERE id = $1 AND deleted_at IS NULL`,
    [actor.uid],
  );
}

export async function listManagedUsers(limit = 100): Promise<ManagedUser[]> {
  const result = await query(
    `SELECT ${MANAGED_COLUMNS}
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
  if (!email) throw new ApiError(400, "INVALID_EMAIL", "Enter a valid email address.");
  // Defense in depth: the route already validates with Zod, but this module is
  // also reachable from scripts and future callers.
  if (!isValidRole(input.role)) throw new ApiError(400, "INVALID_ROLE", "Role must be admin, editor, or viewer.");

  // No password supplied means "generate a temporary one" — that generated
  // value is the only case where a plaintext password is returned to the admin.
  const temporaryPassword = input.password ? undefined : generateTemporaryPassword();
  const password = input.password ?? temporaryPassword!;
  const policy = checkPasswordPolicy(password);
  if (!policy.ok) throw new ApiError(400, "WEAK_PASSWORD", policy.message ?? "Password does not meet the policy.");

  // Hash before touching the database: the plaintext never reaches a query
  // argument, a log line, or the audit trail.
  const passwordHash = hashPassword(password);

  try {
    // A single INSERT is the duplicate check. A prior SELECT-then-INSERT could
    // still race two concurrent invites past each other; the partial unique
    // index on lower(email) is the real guarantee, so the conflict is handled
    // where it is actually detected.
    const result = await query(
      `INSERT INTO users(email, password_hash, display_name, role, disabled, email_verified_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 0, ${SQL_NOW}, ${SQL_NOW}, ${SQL_NOW})
       RETURNING ${MANAGED_COLUMNS}`,
      [email, passwordHash, input.displayName?.trim() || null, input.role],
    );
    const row = result.rows[0];
    if (!row) throw new ApiError(500, "USER_CREATE_FAILED", "User creation failed. Please try again.");
    return { ...managed(row), ...(temporaryPassword ? { temporaryPassword } : {}) };
  } catch (error) {
    // The client layer maps SQLite UNIQUE violations to a generic
    // RESOURCE_CONFLICT; for this table the only unique key is the email.
    if (isApiError(error) && (error.code === "RESOURCE_CONFLICT" || error.status === 409)) {
      throw new ApiError(409, "USER_EXISTS", DUPLICATE_EMAIL_MESSAGE);
    }
    if (isApiError(error)) throw error;
    throw new ApiError(500, "USER_CREATE_FAILED", "User creation failed. Please try again.");
  }
}

export async function setUserRole(uid: string, nextRole: Role): Promise<void> {
  if (!isValidRole(nextRole)) throw new ApiError(400, "INVALID_ROLE", "Role must be admin, editor, or viewer.");
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
  const policy = checkPasswordPolicy(next);
  if (!policy.ok) throw new ApiError(400, "WEAK_PASSWORD", policy.message ?? "Password does not meet the policy.");
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
