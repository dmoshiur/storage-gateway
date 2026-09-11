import { parseJson } from "@/lib/api/body";
import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { authenticateUser, cookieOptions } from "@/lib/auth/session";
import { writeAuditLogSafely, auditActorFrom } from "@/lib/db/audit";
import { assertSameOrigin, getClientIp } from "@/lib/security/request-auth";
import { enforceRateLimit, enforceDatabaseRateLimit } from "@/lib/security/rate-limit";
import { loginSchema } from "@/lib/validation/schemas";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return apiRoute(request, async (requestId) => {
    assertSameOrigin(request);
    const loginKey = `login:${getClientIp(request)}`;
    enforceRateLimit(loginKey, 10);
    await enforceDatabaseRateLimit(loginKey, 10);
    const input = await parseJson(request, loginSchema, 32 * 1024);
    try {
      const { cookie, actor } = await authenticateUser(input.email, input.password, {
        ip: getClientIp(request),
        userAgent: request.headers.get("user-agent"),
      });
      await writeAuditLogSafely({ action: "LOGIN", actor: auditActorFrom(actor), details: { method: "email_password" }, requestId });
      const response = success({ actor: { uid: actor.uid, email: actor.email, role: actor.role } }, requestId);
      response.cookies.set({ ...cookieOptions(), value: cookie });
      return response;
    } catch (error) {
      await writeAuditLogSafely({ action: "LOGIN_FAILED", actor: { uid: "anonymous", email: input.email.trim().toLowerCase(), type: "system" }, details: { method: "email_password" }, requestId });
      throw error;
    }
  }, { route: "auth/login" });
}
