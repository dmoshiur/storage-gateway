import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { ApiError } from "@/lib/api/errors";
import { toServiceFailure } from "@/lib/api/failures";
import { parseQuery } from "@/lib/api/body";
import { listFiles } from "@/lib/firestore/files";
import { requireReadActor } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { listFilesQuerySchema } from "@/lib/validation/schemas";

export const runtime = "nodejs";

/**
 * GET /api/files — the Files page data source.
 *
 * Reads real metadata from the Firestore `files` collection through the Admin
 * SDK. There is no fallback dataset: when Firestore fails, the underlying
 * cause is logged with the requestId and returned to the caller inside
 * `error.details` so the dashboard can show *why* it could not load instead
 * of a bare "something went wrong".
 */
export async function GET(request: Request) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireReadActor(request);
    enforceRateLimit(`files:list:${actor.type}:${actor.uid}`, actor.type === "integration" ? 120 : 240);
    const values = Object.fromEntries(request.url ? new URL(request.url).searchParams.entries() : []);
    const query = parseQuery(values, listFilesQuerySchema);
    try {
      const result = await listFiles({
        ...query,
        // Website integrations never receive trash/deleted/uploading metadata and do not see documents already due for deletion.
        status: actor.type === "integration" ? "active" : query.status,
        filter: actor.type === "integration" && query.filter === "trash" ? "active" : query.filter,
        onlyAccessible: actor.type === "integration",
      });
      return success(result, requestId);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw toServiceFailure({
        status: 503,
        code: "FILES_FETCH_FAILED",
        message: "Unable to load files. The file metadata store did not answer.",
        cause: error,
        operation: "files/list",
        area: "firestore",
        requestId,
        context: { status: query.status, filter: query.filter, sort: query.sort },
      });
    }
  }, { route: "files/list" });
}
