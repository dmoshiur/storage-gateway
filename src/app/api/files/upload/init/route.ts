import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { parseJson } from "@/lib/api/body";
import { uploadInitSchema } from "@/lib/validation/schemas";
import { assertUploadMetadata } from "@/lib/validation/pdf";
import { getSettings } from "@/lib/firestore/settings";
import { createUploadingFile, markUploadFailed, serializeFile } from "@/lib/firestore/files";
import { getStorageStats } from "@/lib/firestore/stats";
import { defaultRetention } from "@/lib/retention";
import { getStorageService } from "@/lib/storage";
import { ApiError } from "@/lib/api/errors";

export const runtime = "nodejs";

function storageKey(prefix: "pdfs" | "uploads"): string {
  const now = new Date();
  return `${prefix}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}.pdf`;
}

export async function POST(request: Request) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "manage_files", true);
    enforceRateLimit(`upload:init:${actor.uid}`, 30);
    const input = await parseJson(request, uploadInitSchema);
    const [settings, stats] = await Promise.all([getSettings(), getStorageStats()]);
    assertUploadMetadata(input.originalName, input.size, settings.maxPdfSizeBytes);
    if (stats.totalStorageBytes + stats.pendingUploadBytes + input.size > settings.storageLimitBytes) {
      throw new ApiError(409, "STORAGE_LIMIT_EXCEEDED", "Uploading this PDF would exceed the configured storage limit.");
    }

    const retention = input.retention ?? defaultRetention(settings);
    const file = await createUploadingFile({
      storageKey: storageKey("pdfs"),
      uploadKey: storageKey("uploads"),
      originalName: input.originalName,
      title: input.title || input.originalName.replace(/\.pdf$/i, ""),
      description: input.description,
      category: input.category,
      tags: input.tags,
      size: input.size,
      uploadedBy: actor.uid,
      retention,
    });

    try {
      const expiresInSeconds = Math.min(20 * 60, Math.max(5 * 60, settings.signedUrlExpirySeconds));
      const uploadUrl = await getStorageService().getSignedUploadUrl(file.uploadKey!, {
        expiresInSeconds,
        contentLength: file.size,
        metadata: { "file-id": file.id },
      });
      return success({
        file: serializeFile(file),
        uploadUrl,
        uploadHeaders: {
          "Content-Type": "application/pdf",
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
