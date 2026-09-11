import { parseJson } from "@/lib/api/body";
import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { getUserById, resetUserPassword } from "@/lib/db/users";
import { verifyPassword } from "@/lib/auth/password";
import { ApiError } from "@/lib/api/errors";
import { passwordChangeSchema } from "@/lib/validation/schemas";
import { writeAuditLogSafely, auditActorFrom } from "@/lib/db/audit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "read_files", true);
    const input = await parseJson(request, passwordChangeSchema, 32 * 1024);
    const user = await getUserById(actor.uid);
    if (!user || !verifyPassword(input.currentPassword, user.password_hash)) throw new ApiError(401, "CURRENT_PASSWORD_INVALID", "The current password is incorrect.");
    await resetUserPassword(actor.uid, input.newPassword);
    await writeAuditLogSafely({ action: "PASSWORD_RESET", actor: auditActorFrom(actor), details: { method: "change" }, requestId });
    return success({ changed: true }, requestId);
  }, { route: "auth/password/change" });
}
