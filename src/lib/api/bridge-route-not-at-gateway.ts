import { NextResponse } from "next/server";
import { requestIdFrom } from "@/lib/api/response";

/**
 * JSON diagnostic for requests that reach the Next.js gateway on a path that is
 * owned by the FastAPI bridge (for example `/api/v1/storage/upload`).
 *
 * The gateway intentionally does not implement `/api/v1/*`; PDF coordinates are
 * proxied to the bridge's own origin by the integration server. Returning a
 * structured JSON response (instead of the default Next.js HTML 404 page) makes
 * a misconfigured `AM_STORAGE_BRIDGE_URL` immediately actionable for callers.
 */
export function bridgeRouteNotAtGateway(request: Request): NextResponse {
  const publicBridgeUrl = (process.env.NEXT_PUBLIC_BRIDGE_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
  const requestId = requestIdFrom(request);

  const baseMessage =
    "POST /api/v1/storage/upload is served by the AM Storage Bridge (FastAPI), not by this Next.js gateway. " +
    "The upload must be sent to the FastAPI bridge origin, not to this host.";
  const message = publicBridgeUrl
    ? `${baseMessage} The public bridge origin configured for the dashboard is ${publicBridgeUrl}. ` +
      `If that value is this gateway origin, update NEXT_PUBLIC_BRIDGE_URL / BRIDGE_URL on the gateway and ` +
      `AM_STORAGE_BRIDGE_URL on the integration server to the deployed FastAPI bridge origin.`
    : `${baseMessage} No bridge origin is configured on this gateway. Deploy the FastAPI bridge and set ` +
      `NEXT_PUBLIC_BRIDGE_URL (public) / BRIDGE_URL (server-side) / AM_STORAGE_BRIDGE_URL (integration server) to its origin.`;

  return NextResponse.json(
    {
      success: false,
      error: {
        code: "BRIDGE_ENDPOINT_NOT_AT_GATEWAY",
        message,
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
