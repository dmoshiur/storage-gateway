import { NextResponse } from "next/server";
import { requestIdFrom } from "@/lib/api/response";
import { withBridgeCors } from "@/lib/bridge/upload";

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
export function bridgeRouteNotAtGateway(request: Request): Response {
  const requestId = requestIdFrom(request);
  let path = "";
  try {
    path = new URL(request.url).pathname;
  } catch {
    path = "";
  }
  return withBridgeCors(NextResponse.json(
    {
      success: false,
      error: {
        code: "UNKNOWN_BRIDGE_ROUTE",
        message:
          `No /api/v1 route matches '${path || request.url}'. ` +
          "The Storage Bridge runs in this same deployment. Available routes: GET /api/v1/files, POST /api/v1/files, " +
          "GET/PATCH/DELETE /api/v1/files/{id}, GET /api/v1/files/{id}/download, POST /api/v1/files/{id}/restore, " +
          "POST /api/v1/storage/upload (and its init/complete steps), and GET /api/v1/health for liveness.",
        requestId,
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
    }),
    request,
  );
}
