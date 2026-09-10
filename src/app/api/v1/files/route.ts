import { apiRoute } from "@/lib/api/route";
import { bridgePreflightResponse, withBridgeCors } from "@/lib/bridge/upload";
import { handleV1ListFiles } from "@/lib/v1/files";
import { handleBridgeDirectUpload } from "@/lib/bridge/handlers";

export const runtime = "nodejs";

/** GET /api/v1/files — list active files (scope: files:read). */
export async function GET(request: Request) {
  return apiRoute(request, async (requestId) => handleV1ListFiles(request, requestId), { route: "v1/files/list" });
}

/**
 * POST /api/v1/files — multipart upload (scope: files:upload).
 * Small documents only; larger files use the presigned init → PUT → complete flow.
 */
export async function POST(request: Request) {
  return apiRoute(request, async (requestId) =>
    withBridgeCors(await handleBridgeDirectUpload(request, requestId, { requiredScope: "files:upload", allowBearer: true }), request),
  { route: "v1/files/upload" });
}

export async function OPTIONS(request: Request) {
  return bridgePreflightResponse(request);
}

