import { z } from "zod";
import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { parseJson } from "@/lib/api/body";
import { ApiError } from "@/lib/api/errors";
import { describeFailure } from "@/lib/api/failures";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { retentionInputSchema } from "@/lib/validation/schemas";
import {
  beginPermanentDeletion,
  completePermanentDeletion,
  getFileById,
  moveFileToTrash,
  restoreFileFromTrash,
  revertPermanentDeletion,
  setFileFavorite,
  updateFileDetails,
} from "@/lib/db/files";
import { getSettings } from "@/lib/db/settings";
import { writeAuditLogSafely, auditActorFrom } from "@/lib/db/audit";
import { getStorageService } from "@/lib/storage";
import { calculateDeleteAt } from "@/lib/retention";
import { emitWebhookEvent } from "@/lib/webhooks/dispatch";
import { logger } from "@/lib/logging/logger";

export const runtime = "nodejs";

const bulkSchema = z.object({
  action: z.enum(["trash", "restore", "delete", "favorite", "retention"]),
  ids: z.array(z.string().regex(/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i, "The file identifier is invalid.")).min(1).max(100),
  isFavorite: z.boolean().optional(),
  retention: retentionInputSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.action === "favorite" && value.isFavorite === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["isFavorite"], message: "isFavorite is required for the favorite action." });
  }
  if (value.action === "retention" && !value.retention) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["retention"], message: "retention is required for the retention action." });
  }
});

interface ItemResult {
  id: string;
  ok: boolean;
  error?: string;
  /** Underlying dependency code for failed rows. */
  code?: string;
}

export async function POST(request: Request) {
  return apiRoute(request, async (requestId) => {
    const input = await parseJson(request, bulkSchema);
    const capability = input.action === "delete" ? "permanent_delete" : "manage_files";
    const actor = await requireAdminRequest(request, capability, true);
    enforceRateLimit(`files:bulk:${actor.uid}`, 20);

    const settings = await getSettings();
    const storage = getStorageService();
    const results: ItemResult[] = [];
    let succeeded = 0;

    for (const id of input.ids) {
      try {
        const file = await getFileById(id);
        if (!file) throw new ApiError(404, "FILE_NOT_FOUND", "Not found.");
        switch (input.action) {
          case "trash": {
            if (file.status !== "active") throw new ApiError(409, "FILE_NOT_ACTIVE", "Only active documents can be trashed.");
            await moveFileToTrash(id, settings.trashRetentionDays, "manual", actor.uid);
            emitWebhookEvent("file.trashed", { fileId: id, fileName: file.originalName });
            break;
          }
          case "restore": {
            if (file.status !== "trash") throw new ApiError(409, "FILE_NOT_IN_TRASH", "Only trashed documents can be restored.");
            if (!await storage.exists(file.storagePath)) {
              throw new ApiError(409, "FILE_CONTENT_UNAVAILABLE", "Private object unavailable.");
            }
            let nextDeleteAt = file.deleteAt;
            const elapsed = Boolean(file.autoDeleteEnabled && file.deleteAt && file.deleteAt <= new Date());
            const resetElapsedCustomRetention = elapsed && file.retentionType === "custom_date";
            if (elapsed && !resetElapsedCustomRetention) {
              nextDeleteAt = calculateDeleteAt({ autoDeleteEnabled: true, retentionType: file.retentionType, customDeleteAt: null });
            }
            await restoreFileFromTrash(id, { nextDeleteAt, resetElapsedCustomRetention });
            emitWebhookEvent("file.restored", { fileId: id, fileName: file.originalName });
            break;
          }
          case "delete": {
            // The Files page allows an administrator to permanently delete a
            // mixed selection of active and trashed files. Preserve the same
            // safety transition as the single-file action for active records.
            if (file.status === "active") {
              await moveFileToTrash(id, settings.trashRetentionDays, "manual", actor.uid);
            }
            const pending = await beginPermanentDeletion(id);
            if (pending.status !== "deleted") {
              try {
                await storage.delete(pending.storagePath);
                await completePermanentDeletion(id);
                emitWebhookEvent("file.deleted", { fileId: id, fileName: pending.originalName });
              } catch (error) {
                try { await revertPermanentDeletion(id, "BLOB_DELETE_FAILED"); } catch { /* stays pending for cron */ }
                throw error;
              }
            }
            break;
          }
          case "favorite": {
            await setFileFavorite(id, input.isFavorite!);
            break;
          }
          case "retention": {
            await updateFileDetails(id, { retention: input.retention! });
            emitWebhookEvent("file.updated", { fileId: id, fileName: file.originalName });
            break;
          }
        }
        succeeded += 1;
        results.push({ id, ok: true });
      } catch (error) {
        // Never report "Unexpected error." — the underlying PostgreSQL/Blob cause
        // is what the operator needs, both in the row and in the logs.
        const failure = describeFailure(error, "storage");
        // Dependency messages stay in server logs; per-item API responses only
        // expose a stable public message and machine-readable failure code.
        const message = error instanceof ApiError ? error.message : "The action could not be completed.";
        results.push({ id, ok: false, error: message, code: failure.code });
        logger.error("Bulk file action item failed", {
          action: input.action,
          fileId: id,
          causeCode: failure.code,
          error: failure.message,
          publicMessage: message,
          requestId,
        });
      }
    }

    const auditAction = input.action === "trash" ? "BULK_TRASH"
      : input.action === "restore" ? "BULK_RESTORE"
        : input.action === "delete" ? "BULK_DELETE" : "BULK_UPDATE";
    await writeAuditLogSafely({
      action: auditAction,
      actor: auditActorFrom(actor),
      details: { count: input.ids.length, succeeded },
      requestId,
    });
    return success({ succeeded, failed: input.ids.length - succeeded, results }, requestId);
  }, { route: "files/bulk" });
}
