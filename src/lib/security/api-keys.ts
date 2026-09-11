import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ApiError } from "@/lib/api/errors";
import { query, toDate } from "@/lib/db/client";
import { recordApiRequestSafe, type ApiRequestContext } from "@/lib/db/api-metrics";
import { API_SCOPES, type ApiScope } from "@/lib/security/scopes";

export { API_SCOPES, type ApiScope };
export const API_KEY_ID_PREFIX = "am_store_live_";
export const API_SECRET_PREFIX = "am_sec_live_";
export const FULL_API_SCOPES: readonly ApiScope[] = API_SCOPES;

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const b64url = (byteLength: number) => randomBytes(byteLength).toString("base64url");
function constantTimeEquals(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}
function normalizeScopes(value: unknown): ApiScope[] {
  if (!Array.isArray(value)) return [...API_SCOPES];
  const values = value.filter((scope): scope is ApiScope => typeof scope === "string" && (API_SCOPES as readonly string[]).includes(scope));
  return values.length ? [...new Set(values)] : [...API_SCOPES];
}
function expired(value: unknown): boolean {
  const date = toDate(value);
  return Boolean(date && date.getTime() <= Date.now());
}

export interface ApiKeyRecord {
  id: string;
  keyId: string | null;
  prefix: string;
  name: string;
  scopes: ApiScope[];
  expiresAt: string | null;
  createdAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdBy: string;
}

export async function listApiKeys(): Promise<ApiKeyRecord[]> {
  const result = await query(`SELECT id, key_id, prefix, name, scopes, expires_at, created_at, last_used_at, revoked_at, created_by FROM api_keys WHERE kind = 'bridge' ORDER BY created_at DESC`);
  return result.rows.map((row) => ({
    id: String(row.id),
    keyId: typeof row.key_id === "string" ? row.key_id : null,
    prefix: String(row.prefix ?? ""),
    name: String(row.name ?? "Untitled key"),
    scopes: normalizeScopes(row.scopes),
    expiresAt: toDate(row.expires_at)?.toISOString() ?? null,
    createdAt: toDate(row.created_at)?.toISOString() ?? null,
    lastUsedAt: toDate(row.last_used_at)?.toISOString() ?? null,
    revokedAt: toDate(row.revoked_at)?.toISOString() ?? null,
    createdBy: String(row.created_by ?? ""),
  }));
}

/** The plaintext secret is returned once and only its SHA-256 digest is persisted. */
export async function createApiKey(actorUid: string, options: { name?: string; scopes?: ApiScope[]; expiresAt?: Date | null } = {}): Promise<{ id: string; keyId: string; keySecret: string; name: string; scopes: ApiScope[]; expiresAt: string | null }> {
  const keyId = `${API_KEY_ID_PREFIX}${b64url(12)}`;
  const keySecret = `${API_SECRET_PREFIX}${b64url(32)}`;
  const name = options.name?.trim().slice(0, 80) || "Untitled key";
  const scopes = options.scopes?.length ? [...new Set(options.scopes)] : [...API_SCOPES];
  const result = await query(
    `INSERT INTO api_keys(kind, key_id, secret_hash, name, scopes, expires_at, created_by, prefix)
     VALUES ('bridge',$1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [keyId, hash(keySecret), name, scopes, options.expiresAt ?? null, actorUid, API_KEY_ID_PREFIX],
  );
  return { id: String(result.rows[0].id), keyId, keySecret, name, scopes, expiresAt: options.expiresAt?.toISOString() ?? null };
}

export async function rotateApiKey(id: string): Promise<{ id: string; keyId: string; keySecret: string }> {
  const current = await query(`SELECT id, key_id, revoked_at FROM api_keys WHERE id = $1 AND kind = 'bridge'`, [id]);
  const row = current.rows[0];
  if (!row) throw new ApiError(404, "API_KEY_NOT_FOUND", "The API key was not found.");
  if (row.revoked_at) throw new ApiError(409, "API_KEY_REVOKED", "Revoked keys cannot be rotated.");
  const keySecret = `${API_SECRET_PREFIX}${b64url(32)}`;
  await query(`UPDATE api_keys SET secret_hash = $2, legacy_hash = NULL WHERE id = $1`, [id, hash(keySecret)]);
  return { id, keyId: String(row.key_id), keySecret };
}

export async function updateApiKey(id: string, patch: { name?: string; scopes?: ApiScope[]; expiresAt?: Date | null }): Promise<void> {
  await query(
    `UPDATE api_keys SET name = COALESCE($2, name), scopes = COALESCE($3, scopes), expires_at = CASE WHEN $4::boolean THEN $5 ELSE expires_at END WHERE id = $1 AND kind = 'bridge'`,
    [id, patch.name?.trim().slice(0, 80) || null, patch.scopes ?? null, patch.expiresAt !== undefined, patch.expiresAt ?? null],
  );
}

export async function revokeApiKey(id: string): Promise<void> {
  const result = await query(`UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND kind = 'bridge'`, [id]);
  if (!result.rowCount) throw new ApiError(404, "API_KEY_NOT_FOUND", "The API key was not found.");
}

interface KeyRecord {
  id: string;
  keyId: string;
  secretHash: string | null;
  ref: { update: (fields: Record<string, unknown>) => Promise<void> };
}

async function findActiveKeyRecord(keyId: string): Promise<KeyRecord | null> {
  const result = await query(`SELECT id, key_id, secret_hash, expires_at, revoked_at FROM api_keys WHERE kind = 'bridge' AND key_id = $1 LIMIT 1`, [keyId]);
  const row = result.rows[0];
  if (!row || row.revoked_at || expired(row.expires_at)) return null;
  return {
    id: String(row.id),
    keyId: String(row.key_id),
    secretHash: typeof row.secret_hash === "string" ? row.secret_hash : null,
    ref: { update: async (fields) => { await query(`UPDATE api_keys SET last_used_at = $2 WHERE id = $1`, [String(row.id), fields.lastUsedAt ?? new Date()]); } },
  };
}

export async function getApiKeyScopes(recordId: string | null): Promise<ApiScope[]> {
  if (!recordId) return [...API_SCOPES];
  const result = await query(`SELECT scopes FROM api_keys WHERE id = $1`, [recordId]);
  return result.rows[0] ? normalizeScopes(result.rows[0].scopes) : [...API_SCOPES];
}
export async function getApiKeyScopesByKeyId(keyId: string | null): Promise<ApiScope[]> {
  if (!keyId) return [...API_SCOPES];
  const result = await query(`SELECT scopes FROM api_keys WHERE key_id = $1`, [keyId]);
  return result.rows[0] ? normalizeScopes(result.rows[0].scopes) : [...API_SCOPES];
}
export function requireScope(granted: readonly string[], scope: ApiScope): void {
  if (!granted.includes(scope)) throw new ApiError(403, "INSUFFICIENT_SCOPE", `This API key is missing the required scope: ${scope}.`);
}

export async function verifyApiCredential(keyId: string, secret: string, requestContext: ApiRequestContext = {}): Promise<string | null> {
  const record = await findActiveKeyRecord(keyId.trim());
  if (!record || !record.secretHash || !constantTimeEquals(record.secretHash, hash(secret))) return null;
  await record.ref.update({ lastUsedAt: new Date() });
  await recordApiRequestSafe(record.keyId, requestContext);
  return record.id;
}

/** Legacy single-header keys are still verified by digest; the raw value is never persisted. */
export async function verifyApiKey(key: string, requestContext: ApiRequestContext = {}): Promise<string | null> {
  const result = await query(`SELECT id, revoked_at, expires_at, secret_hash, legacy_hash FROM api_keys WHERE kind = 'bridge' AND (legacy_hash = $1 OR secret_hash = $1) LIMIT 1`, [hash(key)]);
  const row = result.rows[0];
  if (!row || row.revoked_at || expired(row.expires_at)) return null;
  await query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [row.id]);
  await recordApiRequestSafe("legacy", requestContext);
  return String(row.id);
}
