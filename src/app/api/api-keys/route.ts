import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { createApiKey, listApiKeys, revokeApiKey } from "@/lib/security/api-keys";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return apiRoute(request, async (requestId) => {
    await requireAdminRequest(request, "manage_settings");
    return success({ keys: await listApiKeys() }, requestId);
  }, { route: "api-keys/list" });
}

export async function POST(request: Request) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "manage_settings", true);
    return success(await createApiKey(actor.uid), requestId, 201);
  }, { route: "api-keys/create" });
}

export async function DELETE(request: Request) {
  return apiRoute(request, async (requestId) => {
    await requireAdminRequest(request, "manage_settings", true);
    const keyId = new URL(request.url).searchParams.get("id");
    if (!keyId) throw new Error("Missing key id");
    await revokeApiKey(keyId);
    return success({ revoked: true }, requestId);
  }, { route: "api-keys/revoke" });
}
