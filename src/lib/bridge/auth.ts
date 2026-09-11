import "server-only";

import { createHash } from "node:crypto";
import { ApiError, isApiError } from "@/lib/api/errors";
import { verifyApiCredential, verifyApiKey } from "@/lib/security/api-keys";
import type { ApiRequestContext } from "@/lib/db/api-metrics";

export type BridgeCredentialMode = "dual_token" | "legacy";

export interface BridgeCredential {
  mode: BridgeCredentialMode;
  /** Visible key id for dashboard-managed dual-token credentials; null for legacy header keys. */
  keyId: string | null;
  /** PostgreSQL row id used to load scopes for both modern and legacy credentials. */
  recordId: string;
  /** Identifier recorded in upload logs and uploadedBy; never a raw secret. */
  logKey: string;
}

function unauthorized(): ApiError {
  return new ApiError(
    401,
    "INVALID_API_KEY",
    "Missing or invalid API credential. Send X-AM-Storage-Key-Id with X-AM-Storage-Key-Secret.",
  );
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

/** Validates a digest-backed bridge credential against the PostgreSQL key registry. */
export async function requireBridgeCredential(request: Request, requestContext: ApiRequestContext = {}): Promise<BridgeCredential> {
  const legacy = (request.headers.get("x-am-storage-key") ?? "").trim();
  const keyId = (request.headers.get("x-am-storage-key-id") ?? "").trim();
  const secret = (request.headers.get("x-am-storage-key-secret") ?? "").trim();

  if (legacy && legacy.length <= 200) {
    const recordId = await verifyWithRegistry("key", () => verifyApiKey(legacy, requestContext));
    if (!recordId) throw unauthorized();
    return { mode: "legacy", keyId: null, recordId, logKey: bridgeLogKeyFromHeaders(request) };
  }
  if (keyId && secret && keyId.length <= 80 && secret.length <= 200) {
    const recordId = await verifyWithRegistry("key", () => verifyApiCredential(keyId, secret, requestContext));
    if (!recordId) throw unauthorized();
    return { mode: "dual_token", keyId, recordId, logKey: keyId.slice(0, 80) };
  }
  throw unauthorized();
}
