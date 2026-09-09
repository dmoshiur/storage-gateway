import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { parseQuery } from "@/lib/api/body";
import { listFiles } from "@/lib/firestore/files";
import { requireReadActor } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { listFilesQuerySchema } from "@/lib/validation/schemas";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireReadActor(request);
    enforceRateLimit(`files:list:${actor.type}:${actor.uid}`, actor.type === "integration" ? 120 : 240);
    const values = Object.fromEntries(request.url ? new URL(request.url).searchParams.entries() : []);
    const query = parseQuery(values, listFilesQuerySchema);
    const result = await listFiles({
      ...query,
      // Website integrations never receive trash/deleted/uploading metadata and do not see documents already due for deletion.
      status: actor.type === "integration" ? "active" : query.status,
      filter: actor.type === "integration" && query.filter === "trash" ? "active" : query.filter,
      onlyAccessible: actor.type === "integration",
    });
    return success(result, requestId);
  }, { route: "files/list" });
}
