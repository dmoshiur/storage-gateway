import { NextResponse } from "next/server";
import { ApiError, isApiError } from "@/lib/api/errors";
import { logger } from "@/lib/logging/logger";

export function requestIdFrom(request: Request): string {
  return request.headers.get("x-request-id")?.slice(0, 96) ?? crypto.randomUUID();
}

export function success<T>(data: T, requestId: string, status = 200): NextResponse {
  return NextResponse.json({ success: true, data, requestId }, {
    status,
    headers: { "X-Request-Id": requestId, "Cache-Control": "no-store" },
  });
}

export function failure(error: unknown, requestId: string, context?: Record<string, unknown>): NextResponse {
  if (isApiError(error)) {
    return NextResponse.json({
      success: false,
      error: { code: error.code, message: error.message, ...(error.fields ? { fields: error.fields } : {}) },
      requestId,
    }, {
      status: error.status,
      headers: { "X-Request-Id": requestId, "Cache-Control": "no-store" },
    });
  }

  logger.error("Unhandled API error", { requestId, ...context, error: error instanceof Error ? error.message : "unknown" });
  return NextResponse.json({
    success: false,
    error: {
      code: "INTERNAL_ERROR",
      message: "The request could not be completed. Please try again or contact an administrator.",
    },
    requestId,
  }, {
    status: 500,
    headers: { "X-Request-Id": requestId, "Cache-Control": "no-store" },
  });
}

export function badRequest(message = "The request is invalid.", fields?: Record<string, string>): never {
  throw new ApiError(400, "VALIDATION_ERROR", message, fields);
}
