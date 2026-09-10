import { apiRoute, requireRouteId } from "@/lib/api/route";
import { bridgePreflightResponse } from "@/lib/bridge/upload";
import { handleV1DownloadFile } from "@/lib/v1/files";

export const runtime = "nodejs";

/** GET /api/v1/files/:id/download — temporary signed URL (scope: files:download). */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiRoute(request, async (requestId) =>
    handleV1DownloadFile(request, requestId, requireRouteId((await context.params).id)),
  { route: "v1/files/download" });
}

export async function OPTIONS(request: Request) {
  return bridgePreflightResponse(request);
}
