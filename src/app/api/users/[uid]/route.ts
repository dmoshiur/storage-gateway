import { z } from "zod";
import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { parseJson } from "@/lib/api/body";
import { ApiError } from "@/lib/api/errors";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { setUserDisabled, setUserRole } from "@/lib/firestore/users";
import { writeAuditLogSafely, auditActorFrom } from "@/lib/firestore/audit";
import { ROLES } from "@/types/auth";

export const runtime = "nodejs";

const updateSchema = z.object({
  role: z.enum(ROLES).optional(),
  disabled: z.boolean().optional(),
}).refine((data) => data.role !== undefined || data.disabled !== undefined, "Provide a role or disabled flag.");

export async function PATCH(request: Request, context: { params: Promise<{ uid: string }> }) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "manage_users", true);
    enforceRateLimit(`users:update:${actor.uid}`, 60);
    const input = await parseJson(request, updateSchema);
    const uid = (await context.params).uid;
    if (!uid || uid.length > 128) throw new ApiError(400, "VALIDATION_ERROR", "The user id is invalid.");
    // Admins cannot demote or disable themselves (prevents lockout).
    if (uid === actor.uid && (input.role !== undefined && input.role !== "admin" || input.disabled === true)) {
      throw new ApiError(409, "SELF_LOCKOUT_DENIED", "You cannot demote or disable your own administrator account.");
    }
    if (input.role !== undefined) {
      await setUserRole(uid, input.role);
      await writeAuditLogSafely({
        action: "USER_ROLE_CHANGED",
        actor: auditActorFrom(actor),
        details: { uid, role: input.role },
      });
    }
    if (input.disabled !== undefined) {
      await setUserDisabled(uid, input.disabled);
      await writeAuditLogSafely({
        action: input.disabled ? "USER_DISABLED" : "USER_ENABLED",
        actor: auditActorFrom(actor),
        details: { uid },
      });
    }
    return success({ updated: true }, requestId);
  }, { route: "users/update" });
}
