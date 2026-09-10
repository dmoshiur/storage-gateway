import { apiRoute, requireRouteId } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { ApiError, isApiError } from "@/lib/api/errors";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { activateUpload, clearUploadKey, markUploadFailed, requireFileById, serializeFile } from "@/lib/firestore/files";
import { writeAuditLogSafely, auditActorFrom } from "@/lib/firestore/audit";
import { getStorageService } from "@/lib/storage";
import { assertValidatedR2Document } from "@/lib/validation/documents";

export const runtime = "nodejs";

const VALIDATION_CODES = new Set(["INVALID_FILE_TYPE", "UPLOAD_SIZE_MISMATCH", "UPLOAD_OWNERSHIP_MISMATCH", "INVALID_DOCUMENT"]);

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "manage_files", true);
    enforceRateLimit(`upload:complete:${actor.uid}`, 60);
    const id = requireRouteId((await context.params).id);
    const file = await requireFileById(id);
    if (file.status === "active") return success({ file: serializeFile(file), alreadyCompleted: true }, requestId);
    if (file.status !== "uploading") throw new ApiError(409, "UPLOAD_NOT_PENDING", "This upload is no longer awaiting completion.");

    const storage = getStorageService();
    const stagingKey = file.uploadKey ?? file.storageKey;
    let verifiedEtag: string | undefined;
    try {
      const [metadata, firstBytes, lastBytes] = await Promise.all([
        storage.getMetadata(stagingKey),
        storage.download(stagingKey, "bytes=0-2047"),
        storage.download(stagingKey, "bytes=-2048"),
      ]);
      verifiedEtag = metadata.etag;
      assertValidatedR2Document({
        originalName: file.originalName,
        expectedSize: file.size,
        actualSize: metadata.contentLength,
        contentType: metadata.contentType,
        firstBytes,
        lastBytes,
        objectFileId: metadata.metadata?.["file-id"],
        expectedFileId: file.id,
      });
    } catch (error) {
      if (isApiError(error) && VALIDATION_CODES.has(error.code)) {
        try { await storage.delete(stagingKey); } catch { /* stale upload cleanup will retry if needed */ }
        await markUploadFailed(file.id, error.code);
        await writeAuditLogSafely({ action: "UPLOAD_FAILED", actor: auditActorFrom(actor), fileId: file.id, fileName: file.originalName, details: { reason: error.code } });
        throw error;
      }
      throw new ApiError(502, "STORAGE_UNAVAILABLE", "The document could not be verified in storage. Please retry shortly.");
    }

    try {
      // Publish an immutable final object. The upload URL only authorizes its separate staging key.
      if (stagingKey !== file.storageKey) await storage.copy(stagingKey, file.storageKey, verifiedEtag);
    } catch {
      throw new ApiError(502, "STORAGE_UNAVAILABLE", "The verified document could not be finalized in storage. Please retry shortly.");
    }
    const active = await activateUpload(id);
    // A failed staging deletion is recorded by retaining uploadKey for daily cleanup.
    try { await storage.delete(stagingKey); await clearUploadKey(id); } catch { /* safe, retryable staging cleanup */ }
    await writeAuditLogSafely({ action: "UPLOAD", actor: auditActorFrom(actor), fileId: active.id, fileName: active.originalName, details: { size: active.size } });
    return success({ file: serializeFile(active) }, requestId);
  }, { route: "files/upload/complete" });
}
