import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { parseJson } from "@/lib/api/body";
import { ApiError } from "@/lib/api/errors";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { setUserDisabled, setUserRole, deleteUser, resetUserPassword, revokeUserSessions, listUserActivity } from "@/lib/db/users";
import { writeAuditLogSafely, auditActorFrom } from "@/lib/db/audit";
import { adminResetPasswordSchema, updateUserSchema } from "@/lib/validation/schemas";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ uid: string }> }) {
  return apiRoute(request, async (requestId) => {
    await requireAdminRequest(request, "manage_users");
    const uid = (await context.params).uid;
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(uid)) throw new ApiError(400, "VALIDATION_ERROR", "The user id is invalid.");
    return success({ activity: await listUserActivity(uid) }, requestId);
  }, { route: "users/activity" });
}

export async function PATCH(request: Request, context: { params: Promise<{ uid: string }> }) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "manage_users", true);
    enforceRateLimit(`users:update:${actor.uid}`, 60);
    const input = await parseJson(request, updateUserSchema);
    const uid = (await context.params).uid;
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(uid)) throw new ApiError(400, "VALIDATION_ERROR", "The user id is invalid.");
    if (uid === actor.uid && ((input.role !== undefined && input.role !== "admin") || input.disabled === true)) throw new ApiError(409, "SELF_LOCKOUT_DENIED", "You cannot demote or disable your own administrator account.");
    if (input.role !== undefined) { await setUserRole(uid, input.role); await writeAuditLogSafely({ action: "USER_ROLE_CHANGED", actor: auditActorFrom(actor), details: { userId: uid, role: input.role }, requestId }); }
    if (input.disabled !== undefined) { await setUserDisabled(uid, input.disabled); await writeAuditLogSafely({ action: input.disabled ? "USER_DISABLED" : "USER_ENABLED", actor: auditActorFrom(actor), details: { userId: uid }, requestId }); }
    return success({ updated: true }, requestId);
  }, { route: "users/update" });
}

export async function POST(request: Request, context: { params: Promise<{ uid: string }> }) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "manage_users", true);
    const uid = (await context.params).uid;
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(uid)) throw new ApiError(400, "VALIDATION_ERROR", "The user id is invalid.");
    const input = await parseJson(request, adminResetPasswordSchema);
    const result = await resetUserPassword(uid, input.password);
    await writeAuditLogSafely({ action: "PASSWORD_RESET", actor: auditActorFrom(actor), details: { userId: uid }, requestId });
    return success({ reset: true, ...result }, requestId);
  }, { route: "users/reset-password" });
}

export async function DELETE(request: Request, context: { params: Promise<{ uid: string }> }) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "manage_users", true);
    const uid = (await context.params).uid;
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(uid)) throw new ApiError(400, "VALIDATION_ERROR", "The user id is invalid.");
    if (uid === actor.uid) throw new ApiError(409, "SELF_DELETE_DENIED", "You cannot delete your own administrator account.");
    await deleteUser(uid);
    await revokeUserSessions(uid);
    await writeAuditLogSafely({ action: "USER_DELETED", actor: auditActorFrom(actor), details: { userId: uid }, requestId });
    return success({ deleted: true }, requestId);
  }, { route: "users/delete" });
}
