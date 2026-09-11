import { apiRoute } from "@/lib/api/route";
import { bridgePreflightResponse, withBridgeCors } from "@/lib/bridge/upload";
import { handleV1ListFiles } from "@/lib/v1/files";
import { handleBridgeDirectUpload } from "@/lib/bridge/handlers";

export const runtime = "nodejs";

/** GET /api/v1/files — list active files (scope: files:read). */
export async function GET(request: Request) {
  const response = await apiRoute(request, async (requestId) => handleV1ListFiles(request, requestId), { route: "v1/files/list" });
  return withBridgeCors(response, request);
}

/**
 * POST /api/v1/files — multipart PDF upload (scope: files:upload).
 * Small files only; larger PDFs use the presigned init → PUT → complete flow.
 */
export async function POST(request: Request) {
  const response = await apiRoute(request, (requestId) =>
    handleBridgeDirectUpload(request, requestId, { requiredScope: "files:upload", allowBearer: true }),
  { route: "v1/files/upload" });
  return withBridgeCors(response, request);
}

export async function OPTIONS(request: Request) {
  return bridgePreflightResponse(request);
}
