import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { parseJson } from "@/lib/api/body";
import { requireIntegrationKey } from "@/lib/security/request-auth";
import { verifyApiKey } from "@/lib/security/api-keys";
import { bridgeVerifyKeySchema } from "@/lib/validation/bridge";

export const runtime = "nodejs";

/**
 * Internal, server-to-server key verification used by the AM Storage bridge.
 *
 * The bridge never reads Firestore or raw key digests itself: it forwards the
 * `X-AM-Storage-Key` value it received from gramunnayan.com over TLS and this
 * endpoint checks it against the registry that the dashboard manages. A valid
 * check also refreshes `lastUsedAt`, which is how the dashboard tracks usage.
 */
export async function POST(request: Request) {
  return apiRoute(request, async (requestId) => {
    await requireIntegrationKey(request);
    const { key } = await parseJson(request, bridgeVerifyKeySchema, 1024);
    const keyId = await verifyApiKey(key);
    return success(keyId ? { valid: true, keyId } : { valid: false, keyId: null }, requestId);
  }, { route: "internal/bridge/verify-key" });
}
