import "server-only";

import { ApiError } from "@/lib/api/errors";
import { toServiceFailure } from "@/lib/api/failures";
import { getStorageService } from "@/lib/storage";
import type { FileDocument } from "@/types/file";

/**
 * Serves stored PDF bytes through the authenticated API route itself.
 *
 * The caller must already have authenticated the Firebase user, authorized
 * their role, and loaded the file metadata from Firestore. What this adds is
 * the transport: the bytes are read from the private Blob store with the
 * server-side credential and streamed to the browser, so the browser never
 * receives a Blob URL at all — not a permanent one, and not even a short-lived
 * signed one. Streaming (rather than buffering) keeps large PDFs inside the
 * function's response budget.
 */
export async function streamStoredFile(
  file: FileDocument,
  options: { disposition: "inline" | "attachment"; range?: string; requestId: string },
): Promise<Response> {
  let stored;
  try {
    stored = await getStorageService().downloadStream(file.storagePath, options.range);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw toServiceFailure({
      status: 502,
      code: "FILE_STREAM_FAILED",
      message: "The document could not be streamed from private storage.",
      cause: error,
      operation: "files/stream",
      area: "blob",
      requestId: options.requestId,
      context: { fileId: file.id },
    });
  }

  // RFC 6266: an ASCII fallback plus the UTF-8 encoded original filename.
  const asciiName = file.originalName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "document.pdf";
  const encodedName = encodeURIComponent(file.originalName);
  const headers = new Headers({
    "Content-Type": file.mimeType || "application/pdf",
    "Content-Disposition": `${options.disposition}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
    "Cache-Control": "private, no-store, max-age=0",
    "X-Request-Id": options.requestId,
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
  });
  const length = stored.contentLength ?? (Number.isFinite(file.size) ? file.size : null);
  if (length !== null) headers.set("Content-Length", String(length));

  return new Response(stored.stream, {
    status: stored.statusCode === 206 ? 206 : 200,
    headers,
  });
}
