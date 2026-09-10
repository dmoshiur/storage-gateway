import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { parseJson } from "@/lib/api/body";
import { uploadInitSchema } from "@/lib/validation/schemas";
import { assertDocumentMetadata, stripDocumentExtension } from "@/lib/validation/documents";
import { getSettings } from "@/lib/firestore/settings";
import { createUploadingFile, markUploadFailed, serializeFile } from "@/lib/firestore/files";
import { getStorageStats } from "@/lib/firestore/stats";
import { defaultRetention } from "@/lib/retention";
import { getStorageService } from "@/lib/storage";
import { ApiError } from "@/lib/api/errors";

export const runtime = "nodejs";

function storageKey(prefix: "documents" | "uploads", extension: string): string {
  const now = new Date();
  return `${prefix}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}.${extension}`;
}

export async function POST(request: Request) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "manage_files", true);
    enforceRateLimit(`upload:init:${actor.uid}`, 30);
    const input = await parseJson(request, uploadInitSchema);
    const [settings, stats] = await Promise.all([getSettings(), getStorageStats()]);
    const document = assertDocumentMetadata(input.originalName, input.size, settings.maxPdfSizeBytes, input.mimeType);
    if (stats.totalStorageBytes + stats.pendingUploadBytes + input.size > settings.storageLimitBytes) {
      throw new ApiError(409, "STORAGE_LIMIT_EXCEEDED", "Uploading this document would exceed the configured storage limit.");
    }

    const retention = input.retention ?? defaultRetention(settings);
    const file = await createUploadingFile({
      storageKey: storageKey("documents", document.extension),
      uploadKey: storageKey("uploads", document.extension),
      originalName: input.originalName,
      title: input.title || stripDocumentExtension(input.originalName),
      description: input.description,
      category: input.category,
      tags: input.tags,
      mimeType: document.mimeType,
      extension: document.extension,
      size: input.size,
      uploadedBy: actor.uid,
      retention,
    });

    try {
      const expiresInSeconds = Math.min(20 * 60, Math.max(5 * 60, settings.signedUrlExpirySeconds));
      const uploadUrl = await getStorageService().getSignedUploadUrl(file.uploadKey!, {
        expiresInSeconds,
        contentType: document.mimeType,
        contentLength: file.size,
        metadata: { "file-id": file.id },
      });
      return success({
        file: serializeFile(file),
        uploadUrl,
        uploadHeaders: {
          "Content-Type": document.mimeType,
          "x-amz-meta-file-id": file.id,
        },
        expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      }, requestId, 201);
    } catch (error) {
      await markUploadFailed(file.id, "UPLOAD_URL_GENERATION_FAILED");
      throw error;
    }
  }, { route: "files/upload/init" });
}
