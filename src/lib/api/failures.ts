import "server-only";

import { ApiError } from "@/lib/api/errors";
import { logger } from "@/lib/logging/logger";

const RETRYABLE_CODES = new Set(["TIMEOUT", "DEADLINE_EXCEEDED", "RESOURCE_EXHAUSTED", "ABORTED", "INTERNAL", "UNAVAILABLE", "ECONNRESET", "ETIMEDOUT"]);
const MAX_CAUSE_LENGTH = 400;

export interface UnderlyingFailure {
  code: string;
  message: string;
  retryable: boolean;
  hint: string | null;
}

function codeName(raw: unknown): string {
  if (typeof raw === "number") return `CODE_${raw}`;
  if (typeof raw === "string" && raw.trim()) return raw.trim().toUpperCase().replace(/[\s-]+/g, "_");
  return "UNKNOWN";
}

function safeMessage(value: unknown): string {
  return String(value instanceof Error ? value.message : value ?? "Unknown error").replace(/\s+/g, " ").trim().slice(0, MAX_CAUSE_LENGTH);
}

function hintFor(code: string, area: "database" | "blob"): string | null {
  if (area === "database" && ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "UNAVAILABLE"].includes(code)) {
    return "Check DATABASE_URL, network access, connection limits, and PostgreSQL availability.";
  }
  if (area === "blob" && ["UNAUTHORIZED", "FORBIDDEN", "PERMISSION_DENIED"].includes(code)) {
    return "Attach a private Vercel Blob store to this deployment and keep its token server-only.";
  }
  return null;
}

export function describeFailure(error: unknown, area: "database" | "blob" | "storage" = "database"): UnderlyingFailure {
  const logicalArea = area === "storage" ? "blob" : area;
  if (error instanceof ApiError) {
    return {
      code: error.code,
      message: safeMessage(error.message),
      retryable: error.status >= 500,
      hint: null,
    };
  }
  const raw = error as { code?: unknown; message?: unknown };
  const base = codeName(raw?.code);
  const message = safeMessage(raw?.message ?? error);
  return {
    code: base === "UNKNOWN" ? `${logicalArea.toUpperCase()}_ERROR` : `${logicalArea.toUpperCase()}_${base}`,
    message,
    retryable: RETRYABLE_CODES.has(base),
    hint: hintFor(base, logicalArea),
  };
}

export interface ServiceFailureInput {
  status: number;
  code: string;
  message: string;
  cause: unknown;
  operation: string;
  area?: "database" | "blob" | "storage";
  requestId?: string;
  context?: Record<string, string | number | boolean>;
}

/**
 * Converts dependency failures to an operation-specific, retryable ApiError.
 * The original driver/storage message is logged with bounded context only; it
 * is never serialized into the public response envelope.
 */
export function toServiceFailure(input: ServiceFailureInput): ApiError {
  const failure = describeFailure(input.cause, input.area ?? "database");
  logger.error("Dependency operation failed", {
    requestId: input.requestId ?? null,
    operation: input.operation,
    area: input.area ?? "database",
    publicCode: input.code,
    causeCode: failure.code,
    cause: failure.message,
    retryable: failure.retryable,
    ...(failure.hint ? { hint: failure.hint } : {}),
    ...input.context,
  });
  return new ApiError(input.status, input.code, input.message, undefined, {
    cause: failure.message,
    causeCode: failure.code,
    retryable: failure.retryable,
    operation: input.operation,
    ...(failure.hint ? { hint: failure.hint } : {}),
    ...(input.context ?? {}),
  });
}
