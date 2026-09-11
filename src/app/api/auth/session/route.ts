import { parseJson } from "@/lib/api/body";
import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { createAdminSession, SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS } from "@/lib/auth/session";
import { writeAuditLog, auditActorFrom } from "@/lib/firestore/audit";
import { recordAdminLogin } from "@/lib/firestore/users";
import { assertSameOrigin, getClientIp } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { sessionSchema } from "@/lib/validation/schemas";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return apiRoute(request, async (requestId) => {
    assertSameOrigin(request);
    enforceRateLimit(`login:${getClientIp(request)}`, 10);
    const { idToken } = await parseJson(request, sessionSchema, 16 * 1024);
    // createAdminSession will throw 503 if Firebase Admin is not configured, which surfaces as
    // an actionable error instead of a generic 401.
    const { cookie, actor } = await createAdminSession(idToken);
    // Best-effort audit logging: login should succeed even if Firestore is temporarily unavailable.
    await Promise.all([
      recordAdminLogin(actor).catch(() => undefined),
      writeAuditLog({ action: "LOGIN", actor: auditActorFrom(actor), details: { method: "firebase" } }).catch(() => undefined),
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
  }, { route: "auth/session" });
}
