import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { requireAdminRequest } from "@/lib/security/request-auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "read_files");
    return success({ actor: { uid: actor.uid, email: actor.email, role: actor.role } }, requestId);
  }, { route: "auth/me" });
}
