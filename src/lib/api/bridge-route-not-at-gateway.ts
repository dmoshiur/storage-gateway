import { NextResponse } from "next/server";
import { requestIdFrom } from "@/lib/api/response";

/**
 * JSON diagnostic for unknown `/api/v1/*` subpaths.
 *
 * The Storage Bridge is embedded in this same deployment: integrations call
 * `POST /api/v1/storage/upload` (multipart, up to ~4 MB), the presigned
 * `POST /api/v1/storage/upload/init` → PUT → `POST /api/v1/storage/upload/complete`
 * flow for larger documents, `GET /api/files*` for reads, and
 * `GET /api/v1/health` for liveness. Anything else under `/api/v1/*` lands
 * here with a structured JSON error instead of the default Next.js HTML 404.
 */
export function bridgeRouteNotAtGateway(request: Request): NextResponse {
  const requestId = requestIdFrom(request);
  let path = "";
  try {
    path = new URL(request.url).pathname;
  } catch {
    path = "";
  }
  return NextResponse.json(
    {
      success: false,
      error: {
        code: "UNKNOWN_BRIDGE_ROUTE",
        message:
          `No bridge route matches '${path || request.url}'. ` +
          "The Storage Bridge runs in this same deployment: POST /api/v1/storage/upload for multipart uploads " +
          "(up to ~4 MB), POST /api/v1/storage/upload/init then PUT then POST /api/v1/storage/upload/complete for " +
          "larger documents, GET /api/files and GET /api/files/{id}/download for reads, and GET /api/v1/health for liveness.",
      },
      requestId,
    },
    {
      status: 404,
      headers: {
        "X-Request-Id": requestId,
        "Cache-Control": "no-store",
        "Content-Type": "application/json",
      },
    },
  );
}
