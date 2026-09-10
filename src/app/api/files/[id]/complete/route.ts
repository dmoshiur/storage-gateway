import { apiRoute, requireRouteId } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { ApiError, isApiError } from "@/lib/api/errors";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { parseJsonOptional } from "@/lib/api/body";
import { completeUploadSchema } from "@/lib/validation/schemas";
import {
  activateUpload,
  attachBlobIdentity,
  findActiveFileByContentHash,
  markUploadFailed,
  requireFileById,
  serializeFile,
} from "@/lib/firestore/files";
import { writeAuditLogSafely, auditActorFrom } from "@/lib/firestore/audit";
import { getStorageService } from "@/lib/storage";
import { assertValidatedBlobDocument } from "@/lib/validation/documents";

export const runtime = "nodejs";

const VALIDATION_CODES = new Set(["INVALID_FILE_TYPE", "UPLOAD_SIZE_MISMATCH", "UPLOAD_OWNERSHIP_MISMATCH", "INVALID_DOCUMENT"]);

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "manage_files", true);
    enforceRateLimit(`upload:complete:${actor.uid}`, 60);
    const id = requireRouteId((await context.params).id);
    const body = await parseJsonOptional(request, completeUploadSchema);
    const file = await requireFileById(id);
    if (file.status === "active") return success({ file: serializeFile(file), alreadyCompleted: true }, requestId);
    if (file.status !== "uploading") throw new ApiError(409, "UPLOAD_NOT_PENDING", "This upload is no longer awaiting completion.");

    const storage = getStorageService();
    const objectPath = file.storagePath;
    try {
      const [metadata, firstBytes, lastBytes] = await Promise.all([
        storage.getMetadata(objectPath),
        storage.download(objectPath, "bytes=0-2047"),
        storage.download(objectPath, "bytes=-2048"),
      ]);
      assertValidatedBlobDocument({
        originalName: file.originalName,
        expectedSize: file.size,
        actualSize: metadata.contentLength,
        contentType: metadata.contentType,
        firstBytes,
        lastBytes,
      });
    } catch (error) {
      if (isApiError(error) && VALIDATION_CODES.has(error.code)) {
        try { await storage.delete(objectPath); } catch { /* stale upload cleanup will retry if needed */ }
        await markUploadFailed(file.id, error.code);
        await writeAuditLogSafely({ action: "UPLOAD_FAILED", actor: auditActorFrom(actor), fileId: file.id, fileName: file.originalName, details: { reason: error.code } });
        throw error;
      }
      throw new ApiError(502, "STORAGE_UNAVAILABLE", "The document could not be verified in storage. Please retry shortly.");
    }

    // Remove any legacy staging object, then activate. Direct-to-final Blob
    // uploads need no copy step: activation is a pure metadata transition.
    if (file.uploadKey) {
      try { await storage.delete(file.uploadKey); } catch { /* safe, retryable staging cleanup */ }
    }
    const contentHash = body?.contentHash ?? file.contentHash;
    if (contentHash) await attachBlobIdentity(id, { contentHash });
    const active = await activateUpload(id);
    let duplicateOf: { id: string; originalName: string } | null = null;
    if (contentHash) {
      const existing = await findActiveFileByContentHash(contentHash);
      if (existing && existing.id !== active.id) duplicateOf = { id: existing.id, originalName: existing.originalName };
    }
    await writeAuditLogSafely({ action: "UPLOAD", actor: auditActorFrom(actor), fileId: active.id, fileName: active.originalName, details: { size: active.size } });
    return success({ file: serializeFile(active), duplicateOf }, requestId);
  }, { route: "files/upload/complete" });
}
