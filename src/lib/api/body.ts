import type { z } from "zod";
import { ApiError } from "@/lib/api/errors";

/**
 * Parses small JSON control-plane payloads with both declared-length and actual
 * stream limits. Document bytes are never accepted by this parser; the embedded
 * bridge parses multipart bodies separately with its own size discipline.
 */
export async function parseJson<T extends z.ZodTypeAny>(
  request: Request,
  schema: T,
  maxBytes = 64 * 1024,
): Promise<z.infer<T>> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "This endpoint accepts JSON requests only.");
  }
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > maxBytes) {
    throw new ApiError(413, "REQUEST_TOO_LARGE", "This request is too large.");
  }

  let raw = "";
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "INVALID_JSON", "The request body must be valid JSON.");
  const decoder = new TextDecoder();
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        throw new ApiError(413, "REQUEST_TOO_LARGE", "This request is too large.");
      }
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "INVALID_JSON", "The request body must be valid JSON.");
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new ApiError(400, "INVALID_JSON", "The request body must be valid JSON.");
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) fields[issue.path.join(".") || "body"] = issue.message;
    throw new ApiError(400, "VALIDATION_ERROR", "Some information is missing or invalid.", fields);
  }
  return parsed.data;
}

export function parseQuery<T extends z.ZodTypeAny>(values: Record<string, string>, schema: T): z.infer<T> {
  const parsed = schema.safeParse(values);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) fields[issue.path.join(".") || "query"] = issue.message;
    throw new ApiError(400, "VALIDATION_ERROR", "One or more query parameters are invalid.", fields);
  }
  return parsed.data;
}
