import { parseJson } from "@/lib/api/body";
import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { ApiError } from "@/lib/api/errors";
import { consumePasswordResetToken } from "@/lib/auth/password-reset";
import { resetUserPassword } from "@/lib/db/users";
import { writeAuditLogSafely } from "@/lib/db/audit";
import { assertSameOrigin, getClientIp } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { passwordResetSchema } from "@/lib/validation/schemas";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return apiRoute(request, async (requestId) => {
    assertSameOrigin(request);
    enforceRateLimit(`password-reset-submit:${getClientIp(request)}`, 10);
    const input = await parseJson(request, passwordResetSchema, 32 * 1024);
    const uid = await consumePasswordResetToken(input.token);
    if (!uid) throw new ApiError(400, "RESET_TOKEN_INVALID", "This password reset link is invalid or expired.");
    await resetUserPassword(uid, input.newPassword);
    await writeAuditLogSafely({ action: "PASSWORD_RESET", actor: { uid, email: null, type: "system" }, details: { method: "reset_token" }, requestId });
    return success({ reset: true }, requestId);
  }, { route: "auth/password/reset" });
}
