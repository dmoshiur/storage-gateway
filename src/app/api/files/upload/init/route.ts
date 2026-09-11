import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { parseJson } from "@/lib/api/body";
import { uploadInitSchema } from "@/lib/validation/schemas";
import { assertDocumentMetadata, stripDocumentExtension } from "@/lib/validation/documents";
import { getSettings } from "@/lib/db/settings";
import { createUploadingFile, findActiveFileByContentHash, markUploadFailed, serializeFile } from "@/lib/db/files";
import { getStorageStats } from "@/lib/db/stats";
import { defaultRetention } from "@/lib/retention";
import { getStorageService } from "@/lib/storage";
import { toServiceFailure } from "@/lib/api/failures";
import { ApiError } from "@/lib/api/errors";

export const runtime = "nodejs";

function storagePath(extension: string): string {
  const now = new Date();
  return `pdfs/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}.${extension}`;
}

export async function POST(request: Request) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "manage_files", true);
    enforceRateLimit(`upload:init:${actor.uid}`, 30);
    const input = await parseJson(request, uploadInitSchema);
    let settings;
    let stats;
    try {
      [settings, stats] = await Promise.all([getSettings(), getStorageStats()]);
    } catch (error) {
      // The real PostgreSQL failure is logged and returned; a bare
      // "temporarily unavailable" left operators with nothing to act on.
      throw toServiceFailure({
        status: 503,
        code: "STORAGE_UNAVAILABLE",
        message: "Upload limits could not be read from the metadata store.",
        cause: error,
        operation: "files/upload/init:settings",
        area: "database",
        requestId,
      });
    }
    const document = assertDocumentMetadata(input.originalName, input.size, settings.maxPdfSizeBytes, input.mimeType);
    if (stats.totalStorageBytes + stats.pendingUploadBytes + input.size > settings.storageLimitBytes) {
      throw new ApiError(409, "STORAGE_LIMIT_EXCEEDED", "Uploading this document would exceed the configured storage limit.");
    }

    // Optional duplicate detection: the client may send a SHA-256 hex of the bytes.
    let duplicateOf: { id: string; originalName: string } | null = null;
    if (input.contentHash) {
      const existing = await findActiveFileByContentHash(input.contentHash);
      if (existing) duplicateOf = { id: existing.id, originalName: existing.originalName };
    }

    const retention = input.retention ?? defaultRetention(settings);
    const path = storagePath(document.extension);
    const file = await createUploadingFile({
      storagePath: path,
      uploadKey: null,
      originalName: input.originalName,
      title: input.title || stripDocumentExtension(input.originalName),
      description: input.description,
      category: input.category,
      tags: input.tags,
      mimeType: document.mimeType,
      extension: document.extension,
      size: input.size,
      uploadedBy: actor.uid,
      contentHash: input.contentHash ?? null,
      retention,
    });

    try {
      const expiresInSeconds = Math.min(20 * 60, Math.max(5 * 60, settings.signedUrlExpirySeconds));

      // Legacy flow: mint a server-side presigned PUT URL here. The dashboard
      // now uses the OIDC client flow (uploadPresigned -> /api/blob/upload)
      // and sends directToStorage: true, which skips this extra Vercel API
      // roundtrip entirely — one fewer network call that could stall init.
      let uploadUrl: string | null = null;
      if (!input.directToStorage) {
        uploadUrl = await getStorageService().getSignedUploadUrl(file.storagePath, {
          expiresInSeconds,
          contentType: document.mimeType,
          contentLength: file.size,
          metadata: {},
        });
      }
      return success({
        file: serializeFile(file),
        // Storage pathname the client uploads to via /api/blob/upload.
        pathname: file.storagePath,
        uploadUrl,
        uploadMethod: "PUT",
        uploadHeaders: { "Content-Type": document.mimeType },
        expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
        duplicateOf,
      }, requestId, 201);
    } catch (error) {
      await markUploadFailed(file.id, "UPLOAD_URL_GENERATION_FAILED");
      throw error;
    }
  }, { route: "files/upload/init" });
}
