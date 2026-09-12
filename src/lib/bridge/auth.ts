import "server-only";

import { createHash } from "node:crypto";
import { ApiError, isApiError } from "@/lib/api/errors";
import { logger } from "@/lib/logging/logger";
import {
  verifyApiCredentialDetailed,
  verifyApiKey,
  getApiKeyScopes,
  type ApiKeyRejection,
  type ApiScope,
} from "@/lib/security/api-keys";
import type { ApiRequestContext } from "@/lib/db/api-metrics";

export type BridgeCredentialMode = "dual_token" | "legacy";

export interface BridgeCredential {
  mode: BridgeCredentialMode;
  /** Visible key id for dashboard-managed dual-token credentials; null for legacy header keys. */
  keyId: string | null;
  /** Row id used to load scopes for both modern and legacy credentials. */
  recordId: string;
  /** Identifier recorded in upload logs and uploadedBy; never a raw secret. */
  logKey: string;
  /** Scopes granted by the authenticated key, resolved during verification. */
  scopes: ApiScope[];
}

/**
 * A single, deliberately generic 401 for every credential failure.
 *
 * The precise reason (unknown key id, revoked, expired, wrong secret) is
 * logged server-side only, so the API never becomes an oracle that lets a
 * caller distinguish "this key id exists" from "this secret is wrong".
 */
function unauthorized(): ApiError {
  return new ApiError(
    401,
    "INVALID_API_KEY",
    "Missing or invalid API credential. Send X-AM-Storage-Key-Id with X-AM-Storage-Key-Secret.",
  );
}

/** Server-side record of exactly why authentication failed. Never includes secret material. */
function logAuthFailure(input: {
  reason: ApiKeyRejection | "missing_headers" | "malformed_headers";
  keyId: string | null;
  requestContext: ApiRequestContext;
}): void {
  logger.warn("API key authentication failed", {
    reason: input.reason,
    keyId: input.keyId ?? null,
    method: input.requestContext.method ?? null,
    path: input.requestContext.path ?? null,
    requestId: input.requestContext.requestId ?? null,
    ip: input.requestContext.ip ?? null,
  });
}

/** True when the request carries a dashboard-managed bridge credential header. */
export function hasBridgeCredentialHeaders(request: Request): boolean {
  return request.headers.has("x-am-storage-key") || request.headers.has("x-am-storage-key-id") || request.headers.has("x-am-storage-key-secret");
}

/** Log-safe identifier derived from headers alone; raw credential values never enter logs. */
export function bridgeLogKeyFromHeaders(request: Request): string {
  const keyId = (request.headers.get("x-am-storage-key-id") ?? "").trim();
  if (keyId) return keyId.slice(0, 80);
  const legacy = (request.headers.get("x-am-storage-key") ?? "").trim();
  if (legacy) return `legacy:${createHash("sha256").update(legacy).digest("hex").slice(0, 16)}`;
  return "rejected";
}

async function verifyWithRegistry<T>(label: string, verify: () => Promise<T>): Promise<T> {
  try {
    return await verify();
  } catch (error) {
    if (isApiError(error)) throw error;
    throw new ApiError(503, "KEY_SERVICE_UNAVAILABLE", `The ${label} registry is temporarily unavailable. Please retry shortly.`);
  }
}

/** Validates a digest-backed bridge credential against the key registry. */
export async function requireBridgeCredential(request: Request, requestContext: ApiRequestContext = {}): Promise<BridgeCredential> {
  const legacy = (request.headers.get("x-am-storage-key") ?? "").trim();
  const keyId = (request.headers.get("x-am-storage-key-id") ?? "").trim();
  const secret = (request.headers.get("x-am-storage-key-secret") ?? "").trim();

  if (legacy && legacy.length <= 200) {
    const recordId = await verifyWithRegistry("key", () => verifyApiKey(legacy, requestContext));
    if (!recordId) {
      logAuthFailure({ reason: "not_found", keyId: null, requestContext });
      throw unauthorized();
    }
    return { mode: "legacy", keyId: null, recordId, logKey: bridgeLogKeyFromHeaders(request), scopes: await getApiKeyScopes(recordId) };
  }

  if (keyId && secret && keyId.length <= 80 && secret.length <= 200) {
    const { credential, rejection } = await verifyWithRegistry("key", () => verifyApiCredentialDetailed(keyId, secret, requestContext));
    if (!credential) {
      logAuthFailure({ reason: rejection ?? "not_found", keyId, requestContext });
      throw unauthorized();
    }
    return { mode: "dual_token", keyId: credential.keyId, recordId: credential.recordId, logKey: credential.keyId.slice(0, 80), scopes: credential.scopes };
  }

  logAuthFailure({
    reason: keyId || secret || legacy ? "malformed_headers" : "missing_headers",
    keyId: keyId ? keyId.slice(0, 80) : null,
    requestContext,
  });
  throw unauthorized();
}
