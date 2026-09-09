import { apiRoute, requireRouteId } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { ApiError } from "@/lib/api/errors";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { requireFileById, restoreFileFromTrash, serializeFile } from "@/lib/firestore/files";
import { writeAuditLogSafely, auditActorFrom } from "@/lib/firestore/audit";
import { getStorageService } from "@/lib/storage";
import { calculateDeleteAt } from "@/lib/retention";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "manage_files", true);
    enforceRateLimit(`files:restore:${actor.uid}`, 60);
    const file = await requireFileById(requireRouteId((await context.params).id));
    if (file.status !== "trash") throw new ApiError(409, "FILE_NOT_IN_TRASH", "Only PDFs in Trash can be restored.");
    if (!await getStorageService().exists(file.storageKey)) {
      throw new ApiError(409, "FILE_CONTENT_UNAVAILABLE", "This PDF can no longer be restored because its private object is unavailable.");
    }
    // A restored file must not immediately be swept again. Recalculate elapsed policies server-side.
    let nextDeleteAt = file.deleteAt;
    const resetElapsedCustomRetention = Boolean(file.autoDeleteEnabled && file.deleteAt && file.deleteAt <= new Date() && file.retentionType === "custom_date");
    if (file.autoDeleteEnabled && file.deleteAt && file.deleteAt <= new Date() && !resetElapsedCustomRetention) {
      nextDeleteAt = calculateDeleteAt({ autoDeleteEnabled: true, retentionType: file.retentionType, customDeleteAt: null });
    }
    const restored = await restoreFileFromTrash(file.id, { nextDeleteAt, resetElapsedCustomRetention });
    await writeAuditLogSafely({ action: "RESTORE", actor: auditActorFrom(actor), fileId: restored.id, fileName: restored.originalName, details: { resetElapsedCustomRetention } });
    return success({ file: serializeFile(restored) }, requestId);
  }, { route: "files/restore" });
}
