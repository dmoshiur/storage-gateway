import { failure, requestIdFrom } from "@/lib/api/response";
import { ApiError } from "@/lib/api/errors";

export async function apiRoute(request: Request, handler: (requestId: string) => Promise<Response>, context?: Record<string, unknown>): Promise<Response> {
  const requestId = requestIdFrom(request);
  try {
    return await handler(requestId);
  } catch (error) {
    return failure(error, requestId, context);
  }
}

export function requireRouteId(value: string): string {
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(value)) {
    throw new ApiError(400, "INVALID_FILE_ID", "The file identifier is invalid.");
  }
  return value;
}
