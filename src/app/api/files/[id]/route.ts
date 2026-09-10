import { apiRoute, requireRouteId } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { parseJson } from "@/lib/api/body";
import { ApiError } from "@/lib/api/errors";
import { getFileById, serializeFile, updateFileDetails } from "@/lib/firestore/files";
import { writeAuditLogSafely, auditActorFrom } from "@/lib/firestore/audit";
import { requireAdminRequest, requireReadActor } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { fileUpdateSchema, moveToTrashSchema } from "@/lib/validation/schemas";
import { emitWebhookEvent } from "@/lib/webhooks/dispatch";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireReadActor(request);
    enforceRateLimit(`files:get:${actor.type}:${actor.uid}`, actor.type === "integration" ? 240 : 480);
    const file = await getFileById(requireRouteId((await context.params).id));
    if (!file || file.status === "deleted" || file.status === "failed" || file.status === "uploading" || file.status === "deleting") {
      throw new ApiError(404, "FILE_NOT_FOUND", "The requested document was not found.");
    }
    if (actor.type === "integration" && (file.status !== "active" || (file.autoDeleteEnabled && file.deleteAt && file.deleteAt <= new Date()))) {
      throw new ApiError(404, "FILE_NOT_FOUND", "The requested document was not found.");
    }
    return success({ file: serializeFile(file) }, requestId);
  }, { route: "files/get" });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "manage_files", true);
    enforceRateLimit(`files:update:${actor.uid}`, 120);
    const input = await parseJson(request, fileUpdateSchema);
    const id = requireRouteId((await context.params).id);
    const result = await updateFileDetails(id, input);
    await writeAuditLogSafely({
      action: "UPDATE_METADATA",
      actor: auditActorFrom(actor),
      fileId: result.file.id,
      fileName: result.file.originalName,
      details: { fields: Object.keys(input).filter((key) => key !== "retention").join(",") || null },
    });
    if (result.changedRetention) {
      await writeAuditLogSafely({ action: "CHANGE_RETENTION", actor: auditActorFrom(actor), fileId: result.file.id, fileName: result.file.originalName, details: { retentionType: result.file.retentionType, autoDeleteEnabled: result.file.autoDeleteEnabled } });
    }
    emitWebhookEvent("file.updated", { fileId: result.file.id, fileName: result.file.originalName });
    return success({ file: serializeFile(result.file) }, requestId);
  }, { route: "files/update" });
}

/** Soft delete only. Physical Blob bytes remain private until Trash expiry, so restore is lossless. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "manage_files", true);
    enforceRateLimit(`files:trash:${actor.uid}`, 60);
    await parseJson(request, moveToTrashSchema);
    const id = requireRouteId((await context.params).id);
    const { getSettings } = await import("@/lib/firestore/settings");
    const { moveFileToTrash } = await import("@/lib/firestore/files");
    const settings = await getSettings();
    const file = await moveFileToTrash(id, settings.trashRetentionDays, "manual", actor.uid);
    await writeAuditLogSafely({ action: "MOVE_TO_TRASH", actor: auditActorFrom(actor), fileId: file.id, fileName: file.originalName, details: { permanentDeleteAt: file.permanentDeleteAt?.toISOString() ?? null } });
    emitWebhookEvent("file.trashed", { fileId: file.id, fileName: file.originalName });
    return success({ file: serializeFile(file) }, requestId);
  }, { route: "files/trash" });
}
