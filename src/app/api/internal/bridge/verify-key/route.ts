import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { parseJson } from "@/lib/api/body";
import { requireIntegrationKey } from "@/lib/security/request-auth";
import { verifyApiCredential, verifyApiKey, verifyApiSignature } from "@/lib/security/api-keys";
import { bridgeVerifyKeySchema } from "@/lib/validation/bridge";

export const runtime = "nodejs";

/**
 * Internal, server-to-server credential verification used by the AM Storage
 * bridge.
 *
 * The bridge never reads Firestore or raw key material itself: it forwards
 * what gramunnayan.com presented over TLS —
 *   - dual_token : { mode, keyId, secret }        (X-AM-Storage-Key-Id/-Secret)
 *   - signature  : { mode, keyId, timestamp, signature, bodyHash }
 *   - legacy     : { key }                        (single X-AM-Storage-Key)
 * and this endpoint checks it against the dashboard-managed registry. A valid
 * check refreshes `lastUsedAt` and records the request hit that drives the
 * dashboard's "API Requests" metric.
 */
export async function POST(request: Request) {
  return apiRoute(request, async (requestId) => {
    await requireIntegrationKey(request);
    const input = await parseJson(request, bridgeVerifyKeySchema, 2048);
    let keyId: string | null;
    if ("mode" in input && input.mode === "dual_token") {
      keyId = await verifyApiCredential(input.keyId, input.secret);
    } else if ("mode" in input && input.mode === "signature") {
      keyId = await verifyApiSignature({ keyId: input.keyId, timestamp: input.timestamp, signature: input.signature, bodyHash: input.bodyHash });
    } else {
      keyId = await verifyApiKey(input.key);
    }
    return success(keyId ? { valid: true, keyId } : { valid: false, keyId: null }, requestId);
  }, { route: "internal/bridge/verify-key" });
}
