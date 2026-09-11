import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { toServiceFailure } from "@/lib/api/failures";
import { parseQuery } from "@/lib/api/body";
import { listFiles } from "@/lib/db/files";
import { requireReadActor } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { listFilesQuerySchema } from "@/lib/validation/schemas";

export const runtime = "nodejs";

/**
 * GET /api/files — the Files page data source.
 *
 * Reads real metadata from the PostgreSQL `files` table. There is no fallback
 * dataset: when PostgreSQL fails, the underlying cause is logged with the
 * requestId and the caller receives a structured, retryable error.
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
      throw toServiceFailure({
        status: 503,
        code: "FILES_FETCH_FAILED",
        message: "Unable to load files. The file metadata store did not answer.",
        cause: error,
        operation: "files/list",
        area: "database",
        requestId,
        context: { status: query.status, filter: query.filter, sort: query.sort },
      });
    }
  }, { route: "files/list" });
}
