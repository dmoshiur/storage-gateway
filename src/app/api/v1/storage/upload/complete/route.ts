import { apiRoute } from "@/lib/api/route";
import { handleBridgeUploadComplete } from "@/lib/bridge/handlers";
import { bridgePreflightResponse, withBridgeCors } from "@/lib/bridge/upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Step 3 of the presigned bridge upload flow.
 *
 * After the integration PUTs the document bytes to the Blob URL from
 * `POST /api/v1/storage/upload/init`, it calls this endpoint with the returned
 * file id. The staged object is verified (size, content type, ownership, magic
 * bytes), published to its final key, registered, and answered with a signed
 * document URL — the same response shape as a direct upload.
 */
export async function POST(request: Request) {
  const response = await apiRoute(request, (requestId) => handleBridgeUploadComplete(request, requestId), {
    route: "v1/storage/upload/complete",
  });
  return withBridgeCors(response, request);
}

export async function OPTIONS(request: Request) {
  return bridgePreflightResponse(request);
}
