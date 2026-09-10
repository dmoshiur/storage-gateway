import { z } from "zod";
import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { parseJson } from "@/lib/api/body";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import {
  beginPermanentDeletion,
  completePermanentDeletion,
  listFiles,
  revertPermanentDeletion,
} from "@/lib/firestore/files";
import { writeAuditLogSafely, auditActorFrom } from "@/lib/firestore/audit";
import { getStorageService } from "@/lib/storage";
import { logger } from "@/lib/logging/logger";

export const runtime = "nodejs";
export const maxDuration = 60;

const emptyTrashSchema = z.object({
  confirmation: z.literal("EMPTY_TRASH", { errorMap: () => ({ message: 'Type EMPTY_TRASH to confirm.' }) }),
});

/** Permanently delete every document in Trash. Requires typed confirmation. */
export async function DELETE(request: Request) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "permanent_delete", true);
    enforceRateLimit(`files:empty-trash:${actor.uid}`, 5);
    await parseJson(request, emptyTrashSchema);

    const storage = getStorageService();
    let deleted = 0;
    let failed = 0;
    let cursor: string | undefined;
    // Page through Trash; each file is deleted idempotently.
    for (let page = 0; page < 20; page += 1) {
      const { files, nextCursor } = await listFiles({
        pageSize: 50,
        cursor,
        status: "trash",
        filter: "trash",
        sort: "oldest",
        search: "",
      });
      if (files.length === 0) break;
      for (const file of files) {
        try {
          const pending = await beginPermanentDeletion(file.id);
          if (pending.status === "deleted") {
            deleted += 1;
            continue;
          }
          await storage.delete(pending.storagePath);
          await completePermanentDeletion(file.id);
          deleted += 1;
        } catch (error) {
          failed += 1;
          try { await revertPermanentDeletion(file.id, "BLOB_DELETE_FAILED"); } catch { /* cron retries */ }
          logger.error("Empty trash item failed", { fileId: file.id, error: error instanceof Error ? error.message : "unknown" });
        }
      }
      if (!nextCursor) break;
      cursor = nextCursor;
    }

    await writeAuditLogSafely({
      action: "EMPTY_TRASH",
      actor: auditActorFrom(actor),
      details: { deleted, failed },
    });
    return success({ deleted, failed }, requestId);
  }, { route: "files/empty-trash" });
}
