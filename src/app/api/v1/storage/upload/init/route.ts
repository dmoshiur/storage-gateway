import { apiRoute } from "@/lib/api/route";
import { handleBridgeUploadInit } from "@/lib/bridge/handlers";
import { bridgePreflightResponse, withBridgeCors } from "@/lib/bridge/upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Step 1 of the presigned bridge upload flow for larger documents.
 *
 * The integration declares the document as JSON and receives a short-lived R2
 * PUT URL plus the exact headers the PUT must carry. Bytes stream directly to
 * R2, bypassing Vercel's function payload limit entirely, and
 * `POST /api/v1/storage/upload/complete` finalizes the document afterwards.
 */
export async function POST(request: Request) {
  const response = await apiRoute(request, (requestId) => handleBridgeUploadInit(request, requestId), {
    route: "v1/storage/upload/init",
  });
  return withBridgeCors(response, request);
}

export async function OPTIONS(request: Request) {
  return bridgePreflightResponse(request);
}
