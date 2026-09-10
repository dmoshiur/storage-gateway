import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getAdminDb } from "@/lib/firebase/admin";
import { ApiError } from "@/lib/api/errors";
import { recordApiRequestSafe } from "@/lib/firestore/api-metrics";
import { toIso } from "@/utils/date";
import { API_SCOPES, type ApiScope } from "@/lib/security/scopes";

/**
 * Public REST API key model for `/api/v1/*`.
 *
 * A key is a single high-entropy bearer token formatted `ng_live_<43 chars>`.
 * Only its SHA-256 digest is persisted — the raw token is returned exactly once
 * at creation/rotation and can never be read back. Requests authenticate with
 * `Authorization: Bearer ng_live_...` and are checked for: existence, active
 * status, expiry, and the required scope, in that order.
 */

export const BEARER_KEY_PREFIX = "ng_live_";
export const BEARER_KEY_ID_PREFIX = "ng_key_";

const COLLECTION = "v1ApiKeys";

/** Scopes are shared with the dual-token bridge; a key carries any subset. */
export const BEARER_API_SCOPES: readonly ApiScope[] = API_SCOPES;

function collection() {
  return getAdminDb().collection(COLLECTION);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function b64url(byteLength: number): string {
  return randomBytes(byteLength).toString("base64url");
}

function constantTimeEquals(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isExpired(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  const date = value instanceof Date ? value : typeof (value as { toDate?: unknown }).toDate === "function"
    ? (value as { toDate: () => Date }).toDate()
    : new Date(String(value));
  return Number.isFinite(date.getTime()) && date.getTime() <= Date.now();
}

function normalizeScopes(value: unknown): ApiScope[] {
  if (!Array.isArray(value)) return [...API_SCOPES];
  const allowed = new Set<string>(API_SCOPES);
  const scopes = value.filter((scope): scope is ApiScope => typeof scope === "string" && allowed.has(scope));
  return scopes.length > 0 ? [...new Set(scopes)] : [...API_SCOPES];
}

export interface BearerKeyRecord {
  id: string;
  keyId: string;
  prefix: string;
  name: string;
  description: string;
  scopes: ApiScope[];
  expiresAt: string | null;
  createdAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdBy: string;
  /** When this key was produced by rotating another key. */
  rotatedFromId: string | null;
  /** When this key was superseded by a rotation (still valid until revoked). */
  rotatedToId: string | null;
}

export interface CreatedBearerKey {
  id: string;
  keyId: string;
  keySecret: string;
  name: string;
  description: string;
  scopes: ApiScope[];
  expiresAt: string | null;
}

function serializeRecord(id: string, data: Record<string, unknown>): BearerKeyRecord {
  const keyId = typeof data.keyId === "string" ? data.keyId : "";
  return {
    id,
    keyId,
    prefix: typeof data.prefix === "string" && data.prefix ? data.prefix : BEARER_KEY_PREFIX,
    name: typeof data.name === "string" && data.name ? data.name : "Untitled key",
    description: typeof data.description === "string" ? data.description : "",
    scopes: normalizeScopes(data.scopes),
    expiresAt: toIso(data.expiresAt),
    createdAt: toIso(data.createdAt),
    lastUsedAt: toIso(data.lastUsedAt),
    revokedAt: toIso(data.revokedAt),
    createdBy: String(data.createdBy ?? ""),
    rotatedFromId: typeof data.rotatedFromId === "string" ? data.rotatedFromId : null,
    rotatedToId: typeof data.rotatedToId === "string" ? data.rotatedToId : null,
  };
}

export async function listBearerKeys(): Promise<BearerKeyRecord[]> {
  const snapshots = await collection().orderBy("createdAt", "desc").get();
  return snapshots.docs.map((doc) => serializeRecord(doc.id, doc.data() as Record<string, unknown>));
}

export async function getBearerKeyById(id: string): Promise<BearerKeyRecord | null> {
  const snapshot = await collection().doc(id).get();
  if (!snapshot.exists) return null;
  return serializeRecord(snapshot.id, snapshot.data() as Record<string, unknown>);
}

export async function createBearerKey(
  actorUid: string,
  options: { name?: string; description?: string; scopes?: ApiScope[]; expiresAt?: Date | null } = {},
): Promise<CreatedBearerKey> {
  const keyId = `${BEARER_KEY_ID_PREFIX}${b64url(12)}`;
  const keySecret = `${BEARER_KEY_PREFIX}${b64url(32)}`;
  const name = options.name?.trim().slice(0, 80) || "Untitled key";
  const description = options.description?.trim().slice(0, 280) || "";
  const scopes = options.scopes && options.scopes.length > 0 ? [...new Set(options.scopes)] : [...API_SCOPES];

  const reference = await collection().add({
    keyId,
    prefix: BEARER_KEY_PREFIX,
    hash: sha256(keySecret),
    name,
    description,
    scopes,
    createdAt: new Date(),
    expiresAt: options.expiresAt ?? null,
    lastUsedAt: null,
    revokedAt: null,
    createdBy: actorUid,
  });

  return { id: reference.id, keyId, keySecret, name, description, scopes, expiresAt: toIso(options.expiresAt ?? null) };
}

/**
 * Rotation creates a brand-new key that preserves the previous key's metadata
 * and scopes. The old key remains valid during a transition window and is only
 * revoked when the caller confirms — so integrations can switch over safely.
 */
export async function rotateBearerKey(id: string): Promise<CreatedBearerKey> {
  const current = await getBearerKeyById(id);
  if (!current) throw new ApiError(404, "API_KEY_NOT_FOUND", "The API key was not found.");
  if (current.revokedAt) throw new ApiError(409, "API_KEY_REVOKED", "Revoked keys cannot be rotated. Create a new key instead.");

  const created = await createBearerKey(current.createdBy, {
    name: current.name,
    description: current.description,
    scopes: current.scopes,
    expiresAt: current.expiresAt ? new Date(current.expiresAt) : null,
  });

  await collection().doc(created.id).update({ rotatedFromId: id });
  await collection().doc(id).update({ rotatedToId: created.id });
  return created;
}

export async function revokeBearerKey(id: string): Promise<void> {
  const snapshot = await collection().doc(id).get();
  if (!snapshot.exists) throw new ApiError(404, "API_KEY_NOT_FOUND", "The API key was not found.");
  await collection().doc(id).update({ revokedAt: new Date() });
}

export interface VerifiedBearerKey {
  recordId: string;
  keyId: string;
  name: string;
  scopes: ApiScope[];
}

/**
 * Verifies a `ng_live_…` bearer token against the registry. Runs the full
 * check chain the task requires: extract → hash → find → active → expiry.
 * On success it refreshes `lastUsedAt` and records the request hit.
 */
export async function verifyBearerKey(token: string): Promise<VerifiedBearerKey | null> {
  const trimmed = token.trim();
  if (!trimmed.startsWith(BEARER_KEY_PREFIX)) return null;
  if (trimmed.length < BEARER_KEY_PREFIX.length + 32 || !/^[A-Za-z0-9_-]+$/.test(trimmed)) return null;

  const digest = sha256(trimmed);
  const snapshots = await collection().where("hash", "==", digest).limit(1).get();
  const doc = snapshots.docs[0];
  if (!doc) return null;

  const data = doc.data() as Record<string, unknown>;
  const storedHash = typeof data.hash === "string" ? data.hash : null;
  if (!storedHash || !constantTimeEquals(storedHash, digest)) return null;
  if (data.revokedAt) return null;
  if (isExpired(data.expiresAt)) return null;

  await collection().doc(doc.id).update({ lastUsedAt: new Date() });
  await recordApiRequestSafe(typeof data.keyId === "string" ? data.keyId : "unknown");
  return {
    recordId: doc.id,
    keyId: typeof data.keyId === "string" ? data.keyId : "",
    name: typeof data.name === "string" ? data.name : "Untitled key",
    scopes: normalizeScopes(data.scopes),
  };
}

/** Extracts the bearer token from an Authorization header, or null. */
export function bearerTokenFrom(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1]! : null;
}

/** Registry outages read as 503, never as a bad-key rejection. */
export async function verifyBearerKeySafely(token: string): Promise<VerifiedBearerKey | null> {
  try {
    return await verifyBearerKey(token);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, "KEY_SERVICE_UNAVAILABLE", "The API key registry is temporarily unavailable. Please retry shortly.");
  }
}

export function requireBearerScope(granted: readonly string[], scope: ApiScope): void {
  if (!granted.includes(scope)) {
    throw new ApiError(403, "INSUFFICIENT_SCOPE", `This API key is missing the required scope: ${scope}.`);
  }
}
