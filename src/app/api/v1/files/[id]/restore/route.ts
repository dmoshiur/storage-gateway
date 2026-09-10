import { apiRoute, requireRouteId } from "@/lib/api/route";
import { bridgePreflightResponse } from "@/lib/bridge/upload";
import { handleV1RestoreFile } from "@/lib/v1/files";

export const runtime = "nodejs";

/** POST /api/v1/files/:id/restore — restore a trashed file (scope: files:update). */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiRoute(request, async (requestId) =>
    handleV1RestoreFile(request, requestId, requireRouteId((await context.params).id)),
  { route: "v1/files/restore" });
}

export async function OPTIONS(request: Request) {
  return bridgePreflightResponse(request);
}
