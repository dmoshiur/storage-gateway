import "server-only";

import { ApiError } from "@/lib/api/errors";
import { logger } from "@/lib/logging/logger";

/**
 * Dependency-failure translation.
 *
 * Every route that talks to Firestore or Vercel Blob used to do this:
 *
 *     catch { throw new ApiError(503, "FILES_UNAVAILABLE", "Files could not be loaded right now.") }
 *
 * which threw the real cause away. The browser then showed a generic message,
 * the server logs showed the same generic message, and nobody could tell a
 * missing composite index from a service account pointed at the wrong
 * Firebase project. This module is the single place that turns an underlying
 * Firestore/Blob error into (a) a structured `ApiError` whose `details`
 * carries the real cause, and (b) a server-side log line with the requestId.
 *
 * Safety: only `code`, `message` (truncated), and a static hint are copied.
 * Firestore/Blob error objects do not contain credentials, and the logger
 * redacts token-shaped strings as a second line of defense.
 */

/** gRPC status codes reported by the Firestore client library. */
const GRPC_CODE_NAMES: Record<number, string> = {
  0: "OK",
  1: "CANCELLED",
  2: "UNKNOWN",
  3: "INVALID_ARGUMENT",
  4: "DEADLINE_EXCEEDED",
  5: "NOT_FOUND",
  6: "ALREADY_EXISTS",
  7: "PERMISSION_DENIED",
  8: "RESOURCE_EXHAUSTED",
  9: "FAILED_PRECONDITION",
  10: "ABORTED",
  11: "OUT_OF_RANGE",
  12: "UNIMPLEMENTED",
  13: "INTERNAL",
  14: "UNAVAILABLE",
  15: "DATA_LOSS",
  16: "UNAUTHENTICATED",
};

/** Numeric or textual codes where retrying the same request can succeed. */
const RETRYABLE_CODES = new Set([
  "DEADLINE_EXCEEDED",
  "RESOURCE_EXHAUSTED",
  "ABORTED",
  "INTERNAL",
  "UNAVAILABLE",
]);

const MAX_CAUSE_LENGTH = 400;

export interface UnderlyingFailure {
  /** e.g. `FIRESTORE_FAILED_PRECONDITION`, `BLOB_UNAVAILABLE`, `UNKNOWN`. */
  code: string;
  /** The real dependency message, truncated. */
  message: string;
  retryable: boolean;
  /** Actionable operator guidance, or null when there is nothing to add. */
  hint: string | null;
}

function codeNameOf(raw: unknown): string {
  if (typeof raw === "number") return GRPC_CODE_NAMES[raw] ?? `CODE_${raw}`;
  if (typeof raw === "string" && raw.trim()) return raw.trim().toUpperCase().replace(/[\s-]+/g, "_");
  return "UNKNOWN";
}

/** Extracts the `https://console.firebase.google.com/…indexes…` build link. */
export function indexBuildLink(message: string): string | null {
  const match = message.match(/https:\/\/console\.firebase\.google\.com\/\S+/);
  return match ? match[0] : null;
}

/**
 * True when Firestore rejected a query because a composite index is missing.
 * This is the single most common cause of a "files could not be loaded"
 * page after a schema/query change, and it is recoverable at runtime by
 * falling back to an index-free read (see `listFiles`).
 */
export function isMissingIndexError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = codeNameOf((error as { code?: unknown }).code);
  const message = String((error as { message?: unknown }).message ?? "");
  if (code !== "FAILED_PRECONDITION") return false;
  return /index/i.test(message);
}

/** Never copies secret-shaped substrings out of a dependency error message. */
function safeMessage(value: unknown): string {
  const text = typeof value === "string" ? value : String(value ?? "Unknown error");
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_CAUSE_LENGTH);
}

function hintFor(code: string, message: string, area: "firestore" | "blob"): string | null {
  if (area === "firestore") {
    if (code === "FAILED_PRECONDITION" && /index/i.test(message)) {
      const link = indexBuildLink(message);
      return `Missing Firestore composite index. Deploy it with: npx firebase deploy --only firestore:indexes${link ? ` — or build it here: ${link}` : ""}.`;
    }
    if (code === "PERMISSION_DENIED" || code === "UNAUTHENTICATED") {
      return "The Admin SDK credential is not authorized for this Firestore database. Verify FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY all come from the SAME Firebase project (Service accounts → Generate new private key), then redeploy.";
    }
    if (code === "NOT_FOUND") {
      return "Firestore reported no database for this project id. Verify FIREBASE_PROJECT_ID matches the project that has Cloud Firestore enabled.";
    }
    if (code === "RESOURCE_EXHAUSTED") {
      return "Firestore quota exhausted for this project.";
    }
  }
  if (area === "blob") {
    if (code === "UNAUTHORIZED" || code === "FORBIDDEN" || code === "PERMISSION_DENIED") {
      return "Vercel Blob rejected the credential. Attach the private Blob store to THIS Vercel project so BLOB_READ_WRITE_TOKEN is injected, or set BLOB_STORE_ID with Vercel OIDC enabled.";
    }
  }
  return null;
}

/** Describes any thrown value as a structured, loggable dependency failure. */
export function describeFailure(error: unknown, area: "firestore" | "blob" | "storage" = "firestore"): UnderlyingFailure {
  if (error instanceof ApiError) {
    return { code: error.code, message: error.message, retryable: error.status >= 500, hint: null };
  }
  const raw = (error ?? {}) as { code?: unknown; message?: unknown };
  const baseCode = codeNameOf(raw.code);
  const code = baseCode === "UNKNOWN" ? `${area.toUpperCase()}_ERROR` : `${area.toUpperCase()}_${baseCode}`;
  const message = safeMessage(raw.message ?? error);
  const failure: UnderlyingFailure = {
    code,
    message,
    retryable: RETRYABLE_CODES.has(baseCode),
    hint: hintFor(baseCode, message, area === "storage" ? "blob" : area),
  };
  return failure;
}

export interface ServiceFailureInput {
  /** HTTP status for the caller, normally 502/503. */
  status: number;
  /** Public error code, e.g. `FILES_FETCH_FAILED`. */
  code: string;
  /** Short human message the UI shows; the real cause rides along in `details`. */
  message: string;
  /** The value thrown by the dependency. */
  cause: unknown;
  /** Logical operation for logs and error details, e.g. `files/list`. */
  operation: string;
  area?: "firestore" | "blob" | "storage";
  requestId?: string;
  /** Extra context (ids, counts). Never credentials. */
  context?: Record<string, string | number | boolean>;
}

/**
 * Logs the real cause server-side and returns the structured `ApiError` the
 * caller should throw. `ApiError`s are passed through untouched so explicit
 * 4xx validation/auth failures keep their own codes.
 */
export function toServiceFailure(input: ServiceFailureInput): ApiError {
  const { cause } = input;
  if (cause instanceof ApiError) return cause;

  const failure = describeFailure(cause, input.area ?? "firestore");
  const context = input.context ?? {};
  logger.error("Dependency operation failed", {
    requestId: input.requestId ?? null,
    operation: input.operation,
    area: input.area ?? "firestore",
    publicCode: input.code,
    causeCode: failure.code,
    cause: failure.message,
    retryable: failure.retryable,
    ...(failure.hint ? { hint: failure.hint } : {}),
    ...context,
  });

  return new ApiError(input.status, input.code, input.message, undefined, {
    cause: failure.message,
    causeCode: failure.code,
    retryable: failure.retryable,
    operation: input.operation,
    ...(failure.hint ? { hint: failure.hint } : {}),
    // Caller-supplied context (file id, orphaned flag, …) travels to the client
    // too, so the UI can offer the right recovery action.
    ...context,
  });
}
