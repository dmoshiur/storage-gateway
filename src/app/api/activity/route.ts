import { z } from "zod";
import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { parseQuery } from "@/lib/api/body";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { listAuditLogs } from "@/lib/firestore/audit";
import type { AuditAction, SerializedAuditLog } from "@/types/audit";

export const runtime = "nodejs";

const querySchema = z.object({
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().min(8).max(200).optional(),
});

function actorLabel(log: SerializedAuditLog): string {
  if (log.actor.type === "system") return "System";
  if (log.actor.type === "integration") return "Website API";
  return log.actor.email ?? "Admin";
}

function describe(log: SerializedAuditLog): string {
  const file = log.fileName ? ` “${log.fileName}”` : "";
  const map: Record<AuditAction, string> = {
    LOGIN: "signed in",
    LOGOUT: "signed out",
    LOGIN_FAILED: "failed to sign in",
    UPLOAD: `uploaded${file}`,
    UPLOAD_FAILED: `failed to upload${file}`,
    BRIDGE_UPLOAD: `uploaded${file} via the website API`,
    DOWNLOAD: `downloaded${file}`,
    PREVIEW: `previewed${file}`,
    FAVORITE: `${log.details?.isFavorite === false ? "removed from favorites" : "favorited"}${file}`,
    UPDATE_METADATA: `edited metadata for${file}`,
    CHANGE_RETENTION: `changed the retention policy for${file}`,
    BULK_UPDATE: `updated ${String(log.details?.count ?? "multiple")} files`,
    MOVE_TO_TRASH: `moved${file} to Trash`,
    RESTORE: `restored${file} from Trash`,
    BULK_TRASH: `moved ${String(log.details?.count ?? "multiple")} files to Trash`,
    BULK_RESTORE: `restored ${String(log.details?.count ?? "multiple")} files from Trash`,
    EMPTY_TRASH: `emptied Trash (${String(log.details?.deleted ?? 0)} files permanently deleted)`,
    PERMANENT_DELETE: `permanently deleted${file}`,
    BULK_DELETE: `permanently deleted ${String(log.details?.count ?? "multiple")} files`,
    AUTO_DELETE: `was automatically moved to Trash${file}`,
    TRASH_EXPIRY_DELETE: `was permanently deleted after Trash expiry${file}`,
    SETTINGS_CHANGE: "updated system settings",
    API_KEY_CREATED: "created an API key",
    API_KEY_ROTATED: "rotated an API key",
    API_KEY_REVOKED: "revoked an API key",
    USER_INVITED: `invited ${String(log.details?.email ?? "a user")}`,
    USER_ROLE_CHANGED: "changed a user role",
    USER_DISABLED: "disabled a user",
    USER_ENABLED: "re-enabled a user",
    WEBHOOK_CREATED: "created a webhook",
    WEBHOOK_UPDATED: "updated a webhook",
    WEBHOOK_DELETED: "deleted a webhook",
    WEBHOOK_TESTED: "tested a webhook",
    EXPORT: `exported metadata (${String(log.details?.count ?? 0)} files)`,
    CLEANUP_FAILURE: `cleanup failed for${file}`,
  };
  return map[log.action] ?? log.action;
}

/** Human-friendly activity feed (all roles) over the technical audit log. */
export async function GET(request: Request) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "read_files");
    enforceRateLimit(`activity:${actor.uid}`, 60);
    const query = parseQuery(Object.fromEntries(new URL(request.url).searchParams.entries()), querySchema);
    const { logs, nextCursor } = await listAuditLogs(query.pageSize, query.cursor);
    return success({
      activity: logs.map((log) => ({
        id: log.id,
        action: log.action,
        actor: actorLabel(log),
        actorType: log.actor.type,
        description: describe(log),
        fileId: log.fileId ?? null,
        fileName: log.fileName ?? null,
        createdAt: log.createdAt,
      })),
      nextCursor,
    }, requestId);
  }, { route: "activity" });
}
