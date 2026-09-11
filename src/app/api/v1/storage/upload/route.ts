import { NextResponse } from "next/server";
import { apiRoute } from "@/lib/api/route";
import { requestIdFrom } from "@/lib/api/response";
import { handleBridgeDirectUpload } from "@/lib/bridge/handlers";
import { bridgePreflightResponse, withBridgeCors } from "@/lib/bridge/upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Document validation + Blob streaming can take longer than the default budget. */
export const maxDuration = 60;

/**
 * Embedded Storage Bridge — served by this same Vercel deployment.
 *
 * `POST /api/v1/storage/upload` accepts one multipart PDF authenticated with
 * a PostgreSQL-backed API credential (`Authorization: Bearer ng_live_…` or
 * `X-AM-Storage-Key-Id` + `X-AM-Storage-Key-Secret`). It validates the credential, checks the
 * document structure, streams the bytes into the private Blob store, registers
 * the document, logs the attempt for the dashboard, and returns a signed
 * document URL.
 *
 * Vercel functions reject request payloads above ~4.5 MB before this code
 * runs; integrations must send larger documents through the presigned
 * `.../upload/init` → PUT → `.../upload/complete` flow instead.
 */
export async function POST(request: Request) {
  const response = await apiRoute(request, (requestId) => handleBridgeDirectUpload(request, requestId, { allowBearer: true, requiredScope: "files:upload" }), {
    route: "v1/storage/upload",
  });
  return withBridgeCors(response, request);
}

function methodNotAllowed(request: Request): Response {
  const requestId = requestIdFrom(request);
  return withBridgeCors(
    NextResponse.json(
      {
        success: false,
        error: {
          code: "METHOD_NOT_ALLOWED",
          message: "Use POST with multipart/form-data to upload a document, or GET /api/v1/health to check the bridge.",
        },
        requestId,
      },
      { status: 405, headers: { "X-Request-Id": requestId, "Cache-Control": "no-store", Allow: "POST, OPTIONS" } },
    ),
    request,
  );
}

export async function GET(request: Request) {
  return methodNotAllowed(request);
}

export async function PUT(request: Request) {
  return methodNotAllowed(request);
}

export async function PATCH(request: Request) {
  return methodNotAllowed(request);
}

export async function DELETE(request: Request) {
  return methodNotAllowed(request);
}

export async function HEAD(request: Request) {
  return methodNotAllowed(request);
}

export async function OPTIONS(request: Request) {
  return bridgePreflightResponse(request);
}
