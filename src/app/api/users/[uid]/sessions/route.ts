import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { auditActorFrom, writeAuditLogSafely } from "@/lib/db/audit";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { revokeUserSessions } from "@/lib/db/users";
import { ApiError } from "@/lib/api/errors";

export const runtime = "nodejs";

export async function DELETE(request: Request, context: { params: Promise<{ uid: string }> }) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "manage_users", true);
    const uid = (await context.params).uid;
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(uid)) throw new ApiError(400, "VALIDATION_ERROR", "The user id is invalid.");
    const revoked = await revokeUserSessions(uid);
    await writeAuditLogSafely({ action: "SESSIONS_REVOKED", actor: auditActorFrom(actor), details: { userId: uid, revoked }, requestId });
    return success({ revoked }, requestId);
  }, { route: "users/revoke-sessions" });
}
