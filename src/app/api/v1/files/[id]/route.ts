import { apiRoute, requireRouteId } from "@/lib/api/route";
import { bridgePreflightResponse } from "@/lib/bridge/upload";
import { handleV1DeleteFile, handleV1GetFile, handleV1UpdateFile } from "@/lib/v1/files";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiRoute(request, async (requestId) =>
    handleV1GetFile(request, requestId, requireRouteId((await context.params).id)),
  { route: "v1/files/get" });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiRoute(request, async (requestId) =>
    handleV1UpdateFile(request, requestId, requireRouteId((await context.params).id)),
  { route: "v1/files/update" });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiRoute(request, async (requestId) =>
    handleV1DeleteFile(request, requestId, requireRouteId((await context.params).id)),
  { route: "v1/files/delete" });
}

export async function OPTIONS(request: Request) {
  return bridgePreflightResponse(request);
}
