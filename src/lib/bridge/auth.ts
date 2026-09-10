import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { ApiError, isApiError } from "@/lib/api/errors";
import { verifyApiCredential, verifyApiKey, verifyApiSignature } from "@/lib/security/api-keys";
import { recordApiRequestSafe } from "@/lib/firestore/api-metrics";
import { getStaticBridgeKeys } from "@/lib/bridge/config";

export type BridgeCredentialMode = "dual_token" | "signature" | "legacy" | "static";

export interface BridgeCredential {
  mode: BridgeCredentialMode;
  /** Visible key id for dual-token/signature/static-dual requests, else null. */
  keyId: string | null;
  legacyKey: string | null;
  /** Identifier recorded in upload logs and `uploadedBy` (never a raw secret). */
  logKey: string;
}

function unauthorized(): ApiError {
  return new ApiError(
    401,
    "INVALID_API_KEY",
    "Missing or invalid API credential. Send X-AM-Storage-Key-Id with X-AM-Storage-Key-Secret (dual-token) or with X-AM-Storage-Signature and X-AM-Storage-Timestamp (HMAC signed).",
  );
}

/** True when the request carries any bridge credential header. */
export function hasBridgeCredentialHeaders(request: Request): boolean {
  return (
    request.headers.has("x-am-storage-key") ||
    request.headers.has("x-am-storage-key-id") ||
    request.headers.has("x-am-storage-key-secret") ||
    request.headers.has("x-am-storage-signature")
  );
}

/**
 * Log-safe identifier derived from headers alone, used when verification
 * itself fails (or before the body is parsed). Mirrors the standalone bridge:
 * visible key id when present, else a truncated legacy-key preview.
 */
export function bridgeLogKeyFromHeaders(request: Request): string {
  const keyId = (request.headers.get("x-am-storage-key-id") ?? "").trim();
  if (keyId) return keyId.slice(0, 80);
  const legacy = (request.headers.get("x-am-storage-key") ?? "").trim();
  if (legacy) return `${legacy.slice(0, 16)}…`;
  return "rejected";
}

function matchesStaticKey(supplied: string, staticKeys: string[]): boolean {
  const suppliedBytes = Buffer.from(supplied, "utf8");
  let matched = false;
  for (const candidate of staticKeys) {
    const candidateBytes = Buffer.from(candidate, "utf8");
    matched = (candidateBytes.length === suppliedBytes.length && timingSafeEqual(candidateBytes, suppliedBytes)) || matched;
  }
  return matched;
}

async function verifyWithRegistry<T>(label: string, verify: () => Promise<T>): Promise<T> {
  try {
    return await verify();
  } catch (error) {
    // The registry distinguishes unknown/revoked credentials (null) from
    // outages. A reachable registry only answers null for bad credentials, so
    // any transport/upstream failure means the key service itself is down —
    // never treat it as a rejection.
    if (isApiError(error)) throw error;
    throw new ApiError(503, "KEY_SERVICE_UNAVAILABLE", `The ${label} registry is temporarily unavailable. Please retry shortly.`);
  }
}

/**
 * Validates the bridge credential carried by a gramunnayan.com request.
 *
 * Resolution order (same contract as the historical standalone bridge):
 *   1. Static keys (`AM_STORAGE_KEYS`) are accepted locally without a
 *      registry round-trip — legacy header, or a dual-token secret match.
 *   2. Otherwise the credential is verified against the Firestore registry,
 *      which refreshes `lastUsedAt` and records the request hit shown on the
 *      dashboard.
 *
 * For HMAC signed requests the caller must pass the exact raw request bytes
 * (`rawBody`); the signature covers `<timestamp>:<sha256hex(body)>`. Read-only
 * GET requests have no body, so verification uses the empty-body hash.
 */
export async function requireBridgeCredential(request: Request, rawBody?: Uint8Array): Promise<BridgeCredential> {
  const legacy = (request.headers.get("x-am-storage-key") ?? "").trim();
  const keyId = (request.headers.get("x-am-storage-key-id") ?? "").trim();
  const secret = (request.headers.get("x-am-storage-key-secret") ?? "").trim();
  const signature = (request.headers.get("x-am-storage-signature") ?? "").trim();
  const timestampRaw = (request.headers.get("x-am-storage-timestamp") ?? "").trim();

  let mode: "legacy" | "dual_token" | "signature" | null = null;
  if (legacy) mode = "legacy";
  else if (keyId && secret) mode = "dual_token";
  else if (keyId && signature && timestampRaw) mode = "signature";
  if (!mode) throw unauthorized();

  const staticKeys = getStaticBridgeKeys();
  if (staticKeys.length > 0) {
    if (mode === "legacy" && matchesStaticKey(legacy, staticKeys)) {
      await recordApiRequestSafe("static");
      return { mode: "static", keyId: null, legacyKey: legacy, logKey: `${legacy.slice(0, 16)}…` };
    }
    if (mode === "dual_token" && matchesStaticKey(secret, staticKeys)) {
      await recordApiRequestSafe("static");
      return { mode: "static", keyId, legacyKey: null, logKey: keyId.slice(0, 80) };
    }
  }

  if (mode === "legacy") {
    const recordId = await verifyWithRegistry("key", () => verifyApiKey(legacy));
    if (!recordId) throw unauthorized();
    return { mode, keyId: null, legacyKey: legacy, logKey: `${legacy.slice(0, 16)}…` };
  }

  if (mode === "dual_token") {
    const recordId = await verifyWithRegistry("key", () => verifyApiCredential(keyId, secret));
    if (!recordId) throw unauthorized();
    return { mode, keyId, legacyKey: null, logKey: keyId.slice(0, 80) };
  }

  const timestamp = Number(timestampRaw);
  if (!Number.isFinite(timestamp)) throw unauthorized();
  const bodyHash = createHash("sha256").update(rawBody ?? new Uint8Array()).digest("hex");
  const recordId = await verifyWithRegistry("key", () =>
    verifyApiSignature({ keyId, timestamp, signature: signature.toLowerCase(), bodyHash }),
  );
  if (!recordId) throw unauthorized();
  return { mode, keyId, legacyKey: null, logKey: keyId.slice(0, 80) };
}
