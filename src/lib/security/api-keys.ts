import "server-only";
import { createCipheriv, createDecipheriv, createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getAdminDb } from "@/lib/firebase/admin";
import { ApiError } from "@/lib/api/errors";
import { getMasterKey } from "@/lib/env";
import { recordApiRequestSafe } from "@/lib/firestore/api-metrics";
import { toIso } from "@/utils/date";

const collection = () => getAdminDb().collection("apiKeys");

/**
 * Dual-token credential model:
 *
 * - `keyId`   — visible identifier (`am_store_live_…`). Shown in the dashboard
 *               list and sent in the `X-AM-Storage-Key-Id` header.
 * - `keySecret` — high-entropy secret (`am_sec_live_…`). Displayed exactly once
 *               at generation time; only its SHA-256 digest (and, when a master
 *               key is configured, an AES-256-GCM encrypted copy) is persisted.
 *
 * Verification modes:
 * - dual_token : `X-AM-Storage-Key-Id` + `X-AM-Storage-Key-Secret` (digest match)
 * - signature  : `X-AM-Storage-Key-Id` + `X-AM-Storage-Signature` (HMAC-SHA256
 *                over `<timestamp>:<sha256hex(body)>`) + `X-AM-Storage-Timestamp`
 * - legacy     : a single `am_store_live_…` key verified by digest (pre-upgrade keys)
 */
export const API_KEY_ID_PREFIX = "am_store_live_";
export const API_SECRET_PREFIX = "am_sec_live_";

import { API_SCOPES, type ApiScope } from "@/lib/security/scopes";

export { API_SCOPES, type ApiScope };
/** Legacy and static credentials predate scopes and retain full access. */
export const FULL_API_SCOPES: readonly ApiScope[] = API_SCOPES;
/** Signed requests outside this clock-skew window are rejected. */
export const SIGNATURE_MAX_SKEW_MS = 5 * 60 * 1000;

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const b64url = (byteLength: number) => randomBytes(byteLength).toString("base64url");

function constantTimeEquals(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * AES-256-GCM envelope around the raw secret. Only present when
 * AM_STORAGE_MASTER_KEY is configured; it is what makes HMAC signature
 * verification possible without ever storing the plaintext secret.
 */
function encryptSecret(plain: string): string | null {
  const key = getMasterKey();
  if (!key) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

function decryptSecret(payload: string): string {
  const key = getMasterKey();
  if (!key) {
    throw new ApiError(503, "SIGNATURE_VERIFICATION_UNAVAILABLE", "HMAC signature verification is not enabled on this deployment. Set AM_STORAGE_MASTER_KEY to enable it.");
  }
  const raw = Buffer.from(payload, "base64");
  if (raw.length < 12 + 16 + 1) {
    throw new ApiError(503, "SIGNATURE_VERIFICATION_UNAVAILABLE", "This API key cannot be verified with a signed signature.");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  try {
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    throw new ApiError(503, "SIGNATURE_VERIFICATION_UNAVAILABLE", "This API key cannot be verified with a signed signature.");
  }
}

export interface ApiKeyRecord {
  id: string;
  /** Visible identifier for dual-token keys; null for pre-upgrade legacy keys. */
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

function normalizeScopes(value: unknown): ApiScope[] {
  if (!Array.isArray(value)) return [...API_SCOPES];
  const allowed = new Set<string>(API_SCOPES);
  const scopes = value.filter((scope): scope is ApiScope => typeof scope === "string" && allowed.has(scope));
  return scopes.length > 0 ? [...new Set(scopes)] : [...API_SCOPES];
}

export async function listApiKeys(): Promise<ApiKeyRecord[]> {
  const snapshots = await collection().orderBy("createdAt", "desc").get();
  return snapshots.docs.map((doc) => {
    const data = doc.data();
    const keyId = typeof data.keyId === "string" ? data.keyId : null;
    return {
      id: doc.id,
      keyId,
      prefix: keyId ?? String(data.prefix ?? ""),
      name: typeof data.name === "string" && data.name ? data.name : "Untitled key",
      scopes: normalizeScopes(data.scopes),
      expiresAt: toIso(data.expiresAt),
      createdAt: toIso(data.createdAt),
      lastUsedAt: toIso(data.lastUsedAt),
      revokedAt: toIso(data.revokedAt),
      createdBy: String(data.createdBy ?? ""),
    };
  });
}

/**
 * Generates the dual-token pair. The raw secret is returned exactly once and
 * only the digest (plus the encrypted copy for signature mode) is persisted.
 */
export async function createApiKey(
  actorUid: string,
  options: { name?: string; scopes?: ApiScope[]; expiresAt?: Date | null } = {},
): Promise<{ id: string; keyId: string; keySecret: string; name: string; scopes: ApiScope[]; expiresAt: string | null }> {
  const keyId = `${API_KEY_ID_PREFIX}${b64url(12)}`;
  const keySecret = `${API_SECRET_PREFIX}${b64url(32)}`;
  const secretEncrypted = encryptSecret(keySecret);
  const name = options.name?.trim().slice(0, 80) || "Untitled key";
  const scopes = options.scopes && options.scopes.length > 0 ? [...new Set(options.scopes)] : [...API_SCOPES];
  const reference = await collection().add({
    keyId,
    name,
    scopes,
    expiresAt: options.expiresAt ?? null,
    secretHash: hash(keySecret),
    ...(secretEncrypted ? { secretEncrypted } : {}),
    createdAt: new Date(),
    createdBy: actorUid,
    revokedAt: null,
  });
  return { id: reference.id, keyId, keySecret, name, scopes, expiresAt: toIso(options.expiresAt ?? null) };
}

/** Rotation keeps the same key id but issues a fresh secret (shown once). */
export async function rotateApiKey(id: string): Promise<{ id: string; keyId: string; keySecret: string }> {
  const reference = collection().doc(id);
  const snapshot = await reference.get();
  if (!snapshot.exists) throw new ApiError(404, "API_KEY_NOT_FOUND", "The API key was not found.");
  const data = snapshot.data() as Record<string, unknown>;
  if (data.revokedAt) throw new ApiError(409, "API_KEY_REVOKED", "Revoked keys cannot be rotated. Create a new key instead.");
  if (typeof data.keyId !== "string") throw new ApiError(409, "API_KEY_NOT_ROTATABLE", "Legacy keys cannot be rotated. Create a new key instead.");
  const keySecret = `${API_SECRET_PREFIX}${b64url(32)}`;
  const secretEncrypted = encryptSecret(keySecret);
  await reference.update({
    secretHash: hash(keySecret),
    ...(secretEncrypted ? { secretEncrypted } : { secretEncrypted: null }),
    rotatedAt: new Date(),
  });
  return { id, keyId: data.keyId, keySecret };
}

export async function updateApiKey(id: string, patch: { name?: string; scopes?: ApiScope[]; expiresAt?: Date | null }): Promise<void> {
  const updates: Record<string, unknown> = {};
  if (patch.name !== undefined) updates.name = patch.name.trim().slice(0, 80) || "Untitled key";
  if (patch.scopes !== undefined) updates.scopes = [...new Set(patch.scopes)];
  if (patch.expiresAt !== undefined) updates.expiresAt = patch.expiresAt;
  if (Object.keys(updates).length === 0) return;
  await collection().doc(id).update(updates);
}

export async function revokeApiKey(id: string): Promise<void> {
  await collection().doc(id).update({ revokedAt: new Date() });
}

interface KeyRecordSnapshot {
  id: string;
  secretHash: string | null;
  secretEncrypted: string | null;
  ref: { update: (fields: Record<string, unknown>) => Promise<unknown> };
}

async function findActiveKeyRecord(keyId: string): Promise<KeyRecordSnapshot | null> {
  const snapshots = await collection().where("keyId", "==", keyId).limit(1).get();
  const doc = snapshots.docs[0];
  if (!doc) return null;
  const data = doc.data() as Record<string, unknown>;
  if (data.revokedAt) return null;
  if (isExpired(data.expiresAt)) return null;
  return {
    id: doc.id,
    secretHash: typeof data.secretHash === "string" ? data.secretHash : null,
    secretEncrypted: typeof data.secretEncrypted === "string" ? data.secretEncrypted : null,
    ref: doc.ref,
  };
}

function isExpired(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  const date = value instanceof Date ? value : typeof (value as { toDate?: unknown }).toDate === "function"
    ? (value as { toDate: () => Date }).toDate()
    : new Date(String(value));
  return Number.isFinite(date.getTime()) && date.getTime() <= Date.now();
}

/** Scopes for a verified registry credential (legacy/static callers pass null → full access). */
export async function getApiKeyScopes(recordId: string | null): Promise<ApiScope[]> {
  if (!recordId) return [...API_SCOPES];
  try {
    const snapshot = await collection().doc(recordId).get();
    if (!snapshot.exists) return [...API_SCOPES];
    return normalizeScopes((snapshot.data() as Record<string, unknown>).scopes);
  } catch {
    return [...API_SCOPES];
  }
}

/** Scope lookup for versioned-API enforcement (null keyId = legacy/static → full access). */
export async function getApiKeyScopesByKeyId(keyId: string | null): Promise<ApiScope[]> {
  if (!keyId) return [...API_SCOPES];
  try {
    const snapshots = await collection().where("keyId", "==", keyId).limit(1).get();
    const doc = snapshots.docs[0];
    if (!doc) return [...API_SCOPES];
    return normalizeScopes((doc.data() as Record<string, unknown>).scopes);
  } catch {
    return [...API_SCOPES];
  }
}

export function requireScope(granted: readonly string[], scope: ApiScope): void {
  if (!granted.includes(scope)) {
    throw new ApiError(403, "INSUFFICIENT_SCOPE", `This API key is missing the required scope: ${scope}.`);
  }
}

/**
 * Dual-token verification: constant-time digest comparison for the presented
 * (keyId, secret) pair. Touches lastUsedAt and records a request hit so the
 * dashboard can show live gramunnayan.com traffic.
 */
export async function verifyApiCredential(keyId: string, secret: string): Promise<string | null> {
  const trimmedId = keyId.trim();
  const record = await findActiveKeyRecord(trimmedId);
  if (!record) return null;
  if (!record.secretHash || !constantTimeEquals(record.secretHash, hash(secret))) return null;
  await record.ref.update({ lastUsedAt: new Date() });
  await recordApiRequestSafe(trimmedId);
  return record.id;
}

/**
 * HMAC signature verification. The client signs `<timestamp>:<sha256hex(body)>`
 * with the raw secret; the gateway decrypts the stored secret (master key) and
 * recomputes the HMAC in constant time. Rejects stale timestamps (> 5 minute
 * skew) and replayed requests.
 *
 * The timestamp header accepts both unix seconds and unix milliseconds (values
 * below 10^12 are treated as seconds) so documented snippets and millisecond
 * senders interoperate.
 */
export async function verifyApiSignature(input: { keyId: string; timestamp: number; signature: string; bodyHash: string }): Promise<string | null> {
  const trimmedId = input.keyId.trim();
  const record = await findActiveKeyRecord(trimmedId);
  if (!record) return null;
  if (!record.secretEncrypted) {
    throw new ApiError(503, "SIGNATURE_VERIFICATION_UNAVAILABLE", "This API key was created without signature support. Use the dual-token headers instead.");
  }
  const timestampMs = input.timestamp < 1_000_000_000_000 ? input.timestamp * 1000 : input.timestamp;
  if (!Number.isFinite(input.timestamp) || Math.abs(Date.now() - timestampMs) > SIGNATURE_MAX_SKEW_MS) return null;
  const provided = input.signature.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(provided) || !/^[a-f0-9]{64}$/.test(input.bodyHash.trim().toLowerCase())) return null;
  const secret = decryptSecret(record.secretEncrypted);
  const expected = createHmac("sha256", secret).update(`${input.timestamp}:${input.bodyHash.trim().toLowerCase()}`).digest("hex");
  if (!constantTimeEquals(expected, provided)) return null;
  await record.ref.update({ lastUsedAt: new Date() });
  await recordApiRequestSafe(trimmedId);
  return record.id;
}

/**
 * Legacy single-key verification (pre-upgrade `am_store_live_…` keys). Kept so
 * existing gramunnayan.com integrations keep working until they rotate to the
 * dual-token pair.
 */
export async function verifyApiKey(key: string): Promise<string | null> {
  const snapshots = await collection().where("keyHash", "==", hash(key)).limit(1).get();
  if (snapshots.empty || snapshots.docs[0]!.data().revokedAt || isExpired(snapshots.docs[0]!.data().expiresAt)) return null;
  await snapshots.docs[0]!.ref.update({ lastUsedAt: new Date() });
  await recordApiRequestSafe("legacy");
  return snapshots.docs[0]!.id;
}
