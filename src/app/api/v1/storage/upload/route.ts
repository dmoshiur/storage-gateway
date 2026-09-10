import { getBridgeUrl } from "@/lib/env";
import { bridgeRouteNotAtGateway } from "@/lib/api/bridge-route-not-at-gateway";

export const runtime = "nodejs";

/**
 * Optional compatibility proxy: forwards the public bridge upload contract
 * (`POST /api/v1/storage/upload`) to the configured FastAPI bridge origin.
 *
 * The gateway itself does not accept document bytes. This route lets a GUSB
 * integration keep using `AM_STORAGE_BRIDGE_URL=<gateway>` when the operator
 * points the gateway's `BRIDGE_URL` / `NEXT_PUBLIC_BRIDGE_URL` at the deployed
 * FastAPI bridge. For very large documents, call the bridge origin directly or
 * route `/api/v1/*` through a streaming reverse proxy outside Vercel.
 */
async function proxyUpload(request: Request): Promise<Response> {
  const bridgeUrl = getBridgeUrl();
  if (!bridgeUrl) return bridgeRouteNotAtGateway(request);

  const url = `${bridgeUrl}/api/v1/storage/upload`;
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");

  try {
    const upstream = await fetch(url, {
      method: request.method,
      headers,
      body: request.body,
      // @ts-expect-error -- Node's fetch requires duplex for streamed bodies.
      duplex: "half",
      redirect: "manual",
      // The bridge handles multipart uploads itself; keep the gateway prompt.
      cache: "no-store",
    });
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");
    responseHeaders.delete("transfer-encoding");
    responseHeaders.delete("connection");
    responseHeaders.delete("keep-alive");
    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch {
    const requestId = request.headers.get("x-request-id")?.slice(0, 96) ?? crypto.randomUUID();
    return Response.json({
      success: false,
      error: {
        code: "BRIDGE_UNAVAILABLE",
        message: `The AM Storage Bridge could not be reached at ${bridgeUrl}. Check that the FastAPI bridge is running and that BRIDGE_URL / NEXT_PUBLIC_BRIDGE_URL point to it.`,
      },
      requestId,
    }, {
      status: 502,
      headers: { "X-Request-Id": requestId, "Cache-Control": "no-store", "Content-Type": "application/json" },
    });
  }
}

export async function GET(request: Request) {
  return proxyUpload(request);
}

export async function POST(request: Request) {
  return proxyUpload(request);
}

export async function OPTIONS(request: Request) {
  return proxyUpload(request);
}
