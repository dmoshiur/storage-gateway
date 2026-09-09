import { apiRoute } from "@/lib/api/route";
import { parseJson } from "@/lib/api/body";
import { success } from "@/lib/api/response";
import { ApiError } from "@/lib/api/errors";
import { verifyAdminPass } from "@/lib/env";
import { createSharedPassSession } from "@/lib/auth/shared-session";
import { SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS } from "@/lib/auth/session";
import { writeAuditLog, auditActorFrom } from "@/lib/firestore/audit";
import { recordAdminLogin } from "@/lib/firestore/users";
import { assertSameOrigin, getClientIp } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { adminPassSchema } from "@/lib/validation/schemas";

export const runtime = "nodejs";

/**
 * Signs in the shared administrator with the ADMIN_PASS environment passphrase
 * alone — no Firebase account is required. The response sets the same HTTP-only
 * session cookie as a Firebase login, holding a signed shared-pass session.
 * Rotating ADMIN_PASS invalidates every shared-passphrase session.
 */
export async function POST(request: Request) {
  return apiRoute(request, async (requestId) => {
    assertSameOrigin(request);
    enforceRateLimit(`pass-login:${getClientIp(request)}`, 10);
    const { adminPass } = await parseJson(request, adminPassSchema, 1024);
    if (!verifyAdminPass(adminPass)) {
      throw new ApiError(401, "ADMIN_PASS_INVALID", "That passphrase is incorrect. Check it and try again.");
    }
    const { cookie, actor } = createSharedPassSession(SESSION_MAX_AGE_SECONDS);
    await Promise.all([
      recordAdminLogin(actor),
      writeAuditLog({ action: "LOGIN", actor: auditActorFrom(actor), details: { method: "shared_pass" } }),
    ]);
    const response = success({ actor: { uid: actor.uid, email: actor.email, role: actor.role } }, requestId);
    response.cookies.set({
      name: SESSION_COOKIE_NAME,
      value: cookie,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
    return response;
  }, { route: "auth/pass" });
}
