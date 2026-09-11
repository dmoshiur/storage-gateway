import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { toServiceFailure } from "@/lib/api/failures";
import { parseJson } from "@/lib/api/body";
import { requireIntegrationKey } from "@/lib/security/request-auth";
import { bridgeUploadLogSchema } from "@/lib/validation/bridge";
import { recordUploadLog } from "@/lib/db/api-metrics";

export const runtime = "nodejs";

/**
 * Internal, server-to-server upload attempt log from the AM Storage bridge.
 *
 * Every bridge upload attempt — successful or rejected (bad key, invalid document,
 * Blob failure, registration failure) — is recorded here so the dashboard shows
 * a live "API Upload Activity" log with Success/Failed badges. The bridge
 * treats this endpoint as best-effort: a failure to log never affects the
 * upload itself.
 */
export async function POST(request: Request) {
  return apiRoute(request, async (requestId) => {
    await requireIntegrationKey(request, "metadata:write");
    const entry = await parseJson(request, bridgeUploadLogSchema, 4096);
    try {
      await recordUploadLog({
        keyId: entry.keyId,
        filename: entry.filename,
        sizeBytes: entry.sizeBytes,
        status: entry.status,
        failureCode: entry.failureCode,
        requestId: entry.requestId,
        timestamp: entry.timestamp,
      });
    } catch (error) {
      throw toServiceFailure({
        status: 503,
        code: "API_ACTIVITY_WRITE_FAILED",
        message: "API upload activity could not be recorded in PostgreSQL. Please retry shortly.",
        cause: error,
        operation: "internal/bridge/upload-logs:record",
        area: "database",
        requestId,
      });
    }
    return success({ recorded: true }, requestId);
  }, { route: "internal/bridge/upload-logs" });
}
