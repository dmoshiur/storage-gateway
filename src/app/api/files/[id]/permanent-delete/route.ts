import { apiRoute, requireRouteId } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { parseJson } from "@/lib/api/body";
import { ApiError } from "@/lib/api/errors";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { beginPermanentDeletion, completePermanentDeletion, revertPermanentDeletion, serializeFile } from "@/lib/firestore/files";
import { writeAuditLogSafely, auditActorFrom } from "@/lib/firestore/audit";
import { getStorageService } from "@/lib/storage";
import { permanentDeleteSchema } from "@/lib/validation/schemas";
import { logger } from "@/lib/logging/logger";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "manage_files", true);
    enforceRateLimit(`files:permanent-delete:${actor.uid}`, 20);
    await parseJson(request, permanentDeleteSchema);
    const id = requireRouteId((await context.params).id);
    const pending = await beginPermanentDeletion(id);
    if (pending.status === "deleted") return success({ file: serializeFile(pending), alreadyDeleted: true }, requestId);
    try {
      await getStorageService().delete(pending.storageKey);
      const deleted = await completePermanentDeletion(id);
      await writeAuditLogSafely({ action: "PERMANENT_DELETE", actor: auditActorFrom(actor), fileId: deleted.id, fileName: deleted.originalName });
      return success({ file: serializeFile(deleted) }, requestId);
    } catch (error) {
      try { await revertPermanentDeletion(id, "R2_DELETE_FAILED"); } catch { /* pending lifecycle retries safely in cron */ }
      logger.error("Manual permanent delete failed", { fileId: id, error: error instanceof Error ? error.message : "unknown" });
      throw new ApiError(502, "DELETE_FAILED", "The PDF deletion could not be finalized. Its safe deletion state will be retried; refresh Trash or contact an administrator.");
    }
  }, { route: "files/permanent-delete" });
}
