import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { getSessionActorFromCookies, revokeSession, cookieOptions } from "@/lib/auth/session";
import { writeAuditLogSafely, auditActorFrom } from "@/lib/db/audit";
import { assertSameOrigin } from "@/lib/security/request-auth";

export const runtime = "nodejs";

function cookieValue(request: Request): string | undefined {
  return request.headers.get("cookie")?.match(/(?:^|;\s*)storage_gateway_session=([^;]+)/)?.[1];
}

export async function POST(request: Request) {
  return apiRoute(request, async (requestId) => {
    assertSameOrigin(request);
    const actor = await getSessionActorFromCookies();
    await revokeSession(cookieValue(request));
    if (actor) await writeAuditLogSafely({ action: "LOGOUT", actor: auditActorFrom(actor), requestId });
    const response = success({ loggedOut: true }, requestId);
    response.cookies.set({ ...cookieOptions(0), value: "" });
    return response;
  }, { route: "auth/logout" });
}
