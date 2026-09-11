import { failure, requestIdFrom } from "@/lib/api/response";
import { ApiError } from "@/lib/api/errors";
import { logger } from "@/lib/logging/logger";

/**
 * Shared API route wrapper. Every request gets a request id, is measured, and
 * is logged with structured observability fields (requestId, route, method,
 * status, duration, errorCode). The logger redacts secrets and tokens, and no
 * credential material is ever passed through here.
 */
export async function apiRoute(request: Request, handler: (requestId: string) => Promise<Response>, context?: Record<string, unknown>): Promise<Response> {
  const requestId = requestIdFrom(request);
  const method = request.method;
  const route = typeof context?.route === "string" ? context.route : new URL(request.url).pathname;
  const startedAt = Date.now();
  try {
    const response = await handler(requestId);
    const durationMs = Date.now() - startedAt;
    logger.info("API request completed", {
      requestId,
      route,
      method,
      status: response.status,
      durationMs,
    });
    return response;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const status = error instanceof ApiError ? error.status : 500;
    const errorCode = error instanceof ApiError ? error.code : "INTERNAL_ERROR";
    logger.error("API request failed", {
      requestId,
      route,
      method,
      status,
      durationMs,
      errorCode,
      error: error instanceof Error ? error.message : "unknown",
    });
    return failure(error, requestId, context);
  }
}

export function requireRouteId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value)) {
    throw new ApiError(400, "INVALID_FILE_ID", "The file identifier is invalid.");
  }
  return value;
}
