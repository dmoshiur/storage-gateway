import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ApiError } from "@/lib/api/errors";
import { query, toDate, SQL_NOW } from "@/lib/db/client";
import { recordApiRequestSafe, type ApiRequestContext } from "@/lib/db/api-metrics";
import { API_SCOPES, type ApiScope } from "@/lib/security/scopes";

export const BEARER_KEY_PREFIX = "ng_live_";
export const BEARER_KEY_ID_PREFIX = "ng_key_";
export const BEARER_API_SCOPES: readonly ApiScope[] = API_SCOPES;
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function b64url(bytes: number): string { return randomBytes(bytes).toString("base64url"); }
function equal(a: string, b: string): boolean { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
function expired(value: unknown): boolean { const date = toDate(value); return Boolean(date && date.getTime() <= Date.now()); }
function scopes(value: unknown): ApiScope[] { if (!Array.isArray(value)) return [...API_SCOPES]; const result = value.filter((item): item is ApiScope => typeof item === "string" && (API_SCOPES as readonly string[]).includes(item)); return result.length ? [...new Set(result)] : [...API_SCOPES]; }

export interface BearerKeyRecord { id: string; keyId: string; prefix: string; name: string; description: string; scopes: ApiScope[]; expiresAt: string | null; createdAt: string | null; lastUsedAt: string | null; revokedAt: string | null; createdBy: string; rotatedFromId: string | null; rotatedToId: string | null; }
export interface CreatedBearerKey { id: string; keyId: string; keySecret: string; name: string; description: string; scopes: ApiScope[]; expiresAt: string | null; }
function serialize(row: Record<string, unknown>): BearerKeyRecord { return { id: String(row.id), keyId: String(row.key_id ?? ""), prefix: String(row.prefix ?? BEARER_KEY_PREFIX), name: String(row.name ?? "Untitled key"), description: String(row.description ?? ""), scopes: scopes(row.scopes), expiresAt: toDate(row.expires_at)?.toISOString() ?? null, createdAt: toDate(row.created_at)?.toISOString() ?? null, lastUsedAt: toDate(row.last_used_at)?.toISOString() ?? null, revokedAt: toDate(row.revoked_at)?.toISOString() ?? null, createdBy: String(row.created_by ?? ""), rotatedFromId: typeof row.rotated_from_id === "string" ? row.rotated_from_id : null, rotatedToId: typeof row.rotated_to_id === "string" ? row.rotated_to_id : null }; }

export async function listBearerKeys(): Promise<BearerKeyRecord[]> { const result = await query(`SELECT id, key_id, prefix, name, description, scopes, expires_at, created_at, last_used_at, revoked_at, created_by, rotated_from_id, rotated_to_id FROM api_keys WHERE kind = 'bearer' ORDER BY created_at DESC`); return result.rows.map(serialize); }
export async function getBearerKeyById(id: string): Promise<BearerKeyRecord | null> { const result = await query(`SELECT id, key_id, prefix, name, description, scopes, expires_at, created_at, last_used_at, revoked_at, created_by, rotated_from_id, rotated_to_id FROM api_keys WHERE id = $1 AND kind = 'bearer'`, [id]); return result.rows[0] ? serialize(result.rows[0]) : null; }
export async function createBearerKey(actorUid: string, options: { name?: string; description?: string; scopes?: ApiScope[]; expiresAt?: Date | null } = {}): Promise<CreatedBearerKey> {
  const keyId = `${BEARER_KEY_ID_PREFIX}${b64url(12)}`; const keySecret = `${BEARER_KEY_PREFIX}${b64url(32)}`; const name = options.name?.trim().slice(0, 80) || "Untitled key"; const description = options.description?.trim().slice(0, 280) || ""; const selectedScopes = options.scopes?.length ? [...new Set(options.scopes)] : [...API_SCOPES];
  const result = await query(`INSERT INTO api_keys(kind, key_id, secret_hash, name, description, scopes, expires_at, created_by, prefix) VALUES ('bearer',$1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [keyId, sha256(keySecret), name, description, selectedScopes, options.expiresAt ?? null, actorUid, BEARER_KEY_PREFIX]);
  return { id: String(result.rows[0].id), keyId, keySecret, name, description, scopes: selectedScopes, expiresAt: options.expiresAt?.toISOString() ?? null };
}
export async function rotateBearerKey(id: string, rotatingActorUid?: string): Promise<CreatedBearerKey> {
  const current = await getBearerKeyById(id); if (!current) throw new ApiError(404, "API_KEY_NOT_FOUND", "The API key was not found."); if (current.revokedAt) throw new ApiError(409, "API_KEY_REVOKED", "Revoked keys cannot be rotated.");
  const created = await createBearerKey(rotatingActorUid ?? current.createdBy, { name: current.name, description: current.description, scopes: current.scopes, expiresAt: current.expiresAt ? new Date(current.expiresAt) : null });
  await query(`UPDATE api_keys SET rotated_from_id = $2 WHERE id = $1`, [created.id, id]); await query(`UPDATE api_keys SET rotated_to_id = $2 WHERE id = $1`, [id, created.id]);
  return created;
}
export async function revokeBearerKey(id: string): Promise<void> { const result = await query(`UPDATE api_keys SET revoked_at = ${SQL_NOW} WHERE id = $1 AND kind = 'bearer'`, [id]); if (!result.rowCount) throw new ApiError(404, "API_KEY_NOT_FOUND", "The API key was not found."); }
export interface VerifiedBearerKey { recordId: string; keyId: string; name: string; scopes: ApiScope[]; }
export async function verifyBearerKey(token: string, requestContext: ApiRequestContext = {}): Promise<VerifiedBearerKey | null> {
  const trimmed = token.trim(); if (!trimmed.startsWith(BEARER_KEY_PREFIX) || trimmed.length < BEARER_KEY_PREFIX.length + 32 || !/^[A-Za-z0-9_-]+$/.test(trimmed)) return null;
  const digest = sha256(trimmed); const result = await query(`SELECT id, key_id, name, scopes, secret_hash, legacy_hash, revoked_at, expires_at FROM api_keys WHERE kind = 'bearer' AND (secret_hash = $1 OR legacy_hash = $1) LIMIT 1`, [digest]); const row = result.rows[0]; if (!row || row.revoked_at || expired(row.expires_at)) return null;
  const stored = String(row.secret_hash ?? row.legacy_hash ?? ""); if (!equal(stored, digest)) return null;
  await query(`UPDATE api_keys SET last_used_at = ${SQL_NOW} WHERE id = $1`, [row.id]); await recordApiRequestSafe(String(row.key_id ?? "unknown"), requestContext);
  return { recordId: String(row.id), keyId: String(row.key_id ?? ""), name: String(row.name ?? "Untitled key"), scopes: scopes(row.scopes) };
}
export function bearerTokenFrom(request: Request): string | null { const match = /^Bearer\s+(\S+)$/i.exec((request.headers.get("authorization") ?? "").trim()); return match?.[1] ?? null; }
export async function verifyBearerKeySafely(token: string, requestContext: ApiRequestContext = {}): Promise<VerifiedBearerKey | null> { try { return await verifyBearerKey(token, requestContext); } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(503, "KEY_SERVICE_UNAVAILABLE", "The API key registry is temporarily unavailable. Please retry shortly."); } }
export function requireBearerScope(granted: readonly string[], scope: ApiScope): void { if (!granted.includes(scope)) throw new ApiError(403, "INSUFFICIENT_SCOPE", `This API key is missing the required scope: ${scope}.`); }
