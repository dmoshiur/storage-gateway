import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { parseJson } from "@/lib/api/body";
import { getClientIp, requireIntegrationKey } from "@/lib/security/request-auth";
import { verifyApiCredential, verifyApiKey } from "@/lib/security/api-keys";
import { bridgeVerifyKeySchema } from "@/lib/validation/bridge";

export const runtime = "nodejs";

/** Internal server-to-server verification against one-way PostgreSQL key digests. */
export async function POST(request: Request) {
  return apiRoute(request, async (requestId) => {
    await requireIntegrationKey(request);
    const input = await parseJson(request, bridgeVerifyKeySchema, 2048);
    const context = { method: request.method, path: new URL(request.url).pathname, requestId, ip: getClientIp(request) };
    const keyId = "mode" in input
      ? await verifyApiCredential(input.keyId, input.secret, context)
      : await verifyApiKey(input.key, context);
    return success(keyId ? { valid: true, keyId } : { valid: false, keyId: null }, requestId);
  }, { route: "internal/bridge/verify-key" });
}
