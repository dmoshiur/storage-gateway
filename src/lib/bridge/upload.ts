import "server-only";

import { ApiError } from "@/lib/api/errors";
import { recordUploadLog } from "@/lib/firestore/api-metrics";
import { getBridgeCorsOrigins } from "@/lib/bridge/config";
import type { BridgeCredential } from "@/lib/bridge/auth";
import type { SupportedDocumentExtension } from "@/lib/validation/documents";

const BRIDGE_CORS_ALLOW_HEADERS = [
  "X-AM-Storage-Key",
  "X-AM-Storage-Key-Id",
  "X-AM-Storage-Key-Secret",
  "X-AM-Storage-Signature",
  "X-AM-Storage-Timestamp",
  "Content-Type",
  "X-Request-Id",
].join(", ");

/**
 * Keeps multipart filenames inside the 180-character bound while preserving a
 * supported extension. The original name is metadata only — never an object key.
 */
export function cleanBridgeFilename(filename: string): string {
  const name = (filename || "").replace(/\0/g, "").trim();
  if (name.length <= 180) return name;
  const match = name.match(/\.([A-Za-z0-9]+)$/);
  const suffix = match ? `.${match[1]}` : "";
  return name.slice(0, Math.max(0, 180 - suffix.length)) + suffix;
}

/** Accepts a comma-separated list or a JSON array (max 20 tags, validated strictly). */
export function parseBridgeTags(raw: string | null): string[] {
  if (raw === null) return [];
  const text = raw.trim();
  if (!text) return [];
  let parts: string[];
  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new ApiError(400, "VALIDATION_ERROR", "Tags must be a comma-separated list or a JSON array.");
      parts = parsed.map((item) => String(item));
    } catch (error) {
      if (error instanceof ApiError) throw error;
      parts = text.split(",");
    }
  } else {
    parts = text.split(",");
  }
  const tags = parts.map((part) => part.trim().replace(/\s+/g, " ")).filter(Boolean).slice(0, 20);
  for (const tag of tags) {
    if (tag.length > 32) throw new ApiError(400, "VALIDATION_ERROR", "Each tag can be at most 32 characters.");
  }
  return tags;
}

/** Random final object key following the gateway's documents/YYYY/MM/<uuid>.<ext> layout. */
export function buildBridgeObjectKey(extension: SupportedDocumentExtension): string {
  const now = new Date();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `pdfs/${now.getUTCFullYear()}/${month}/${crypto.randomUUID()}.${extension}`;
}

/** Staging key for the presigned init → PUT → complete flow (never served directly). */
export function buildBridgeStagingKey(extension: SupportedDocumentExtension): string {
  const now = new Date();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `uploads/${now.getUTCFullYear()}/${month}/${crypto.randomUUID()}.${extension}`;
}

/** Firestore `uploadedBy` marker tying a bridge file back to its API credential. */
export function bridgeUploader(credential: BridgeCredential): string {
  return `bridge:${credential.logKey}`;
}

/**
 * Best-effort upload-attempt log for the dashboard's "API Upload Activity"
 * widget. Logging is observability: a registry hiccup must never change the
 * outcome of the upload itself.
 */
export async function logBridgeUploadAttempt(entry: {
  keyId: string;
  filename: string;
  sizeBytes: number;
  status: "success" | "failed";
  failureCode: string | null;
  requestId: string;
}): Promise<void> {
  try {
    await recordUploadLog({ ...entry, timestamp: new Date().toISOString() });
  } catch {
    // Pruning/metrics failures only mean slightly less history — never propagate.
  }
}

/** CORS headers for bridge responses. The request origin is echoed only when allow-listed. */
export function bridgeCorsHeaders(request: Request): Record<string, string> {
  const origin = (request.headers.get("origin") ?? "").trim().replace(/\/+$/, "");
  const headers: Record<string, string> = { Vary: "Origin" };
  if (origin && getBridgeCorsOrigins().includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

/** Preflight response for bridge endpoints (mirrors the standalone bridge's CORS policy). */
export function bridgePreflightResponse(request: Request): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...bridgeCorsHeaders(request),
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": BRIDGE_CORS_ALLOW_HEADERS,
      "Access-Control-Max-Age": "86400",
    },
  });
}

/** Attaches bridge CORS headers to any response (success or error envelope). */
export function withBridgeCors(response: Response, request: Request): Response {
  const cors = bridgeCorsHeaders(request);
  for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
  return response;
}
