import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { getSessionActorFromCookies, SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/security/request-auth";
import { writeAuditLogSafely, auditActorFrom } from "@/lib/firestore/audit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return apiRoute(request, async (requestId) => {
    assertSameOrigin(request);
    const actor = await getSessionActorFromCookies();
    if (actor) await writeAuditLogSafely({ action: "LOGOUT", actor: auditActorFrom(actor) });
    const response = success({ loggedOut: true }, requestId);
    response.cookies.set({ name: SESSION_COOKIE_NAME, value: "", httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 0 });
    return response;
  }, { route: "auth/logout" });
}
