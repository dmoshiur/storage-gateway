import { NextResponse } from "next/server";
import { requestIdFrom } from "@/lib/api/response";
import { bridgePreflightResponse, withBridgeCors } from "@/lib/bridge/upload";
import { version as appVersion } from "../../../../../package.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function blobConfigured(): boolean {
  return Boolean(
    (process.env.BLOB_READ_WRITE_TOKEN ?? "").trim() ||
      ((process.env.VERCEL_OIDC_TOKEN ?? "").trim() && (process.env.BLOB_STORE_ID ?? "").trim()),
  );
}

/**
 * Unauthenticated bridge liveness probe for gramunnayan.com.
 *
 * Integrations point their storage URL at this same Vercel app and check
 * `GET <app>/api/v1/health` before uploading.
 */
export async function GET(request: Request) {
  const requestId = requestIdFrom(request);
  return withBridgeCors(
    NextResponse.json(
      {
        status: "ok",
        service: "NGO File Cloud",
        bridge: "ready",
        mode: "embedded",
        version: appVersion,
        auth: "dual-token|hmac|legacy",
        blobConfigured: blobConfigured(),
      },
      { status: 200, headers: { "X-Request-Id": requestId, "Cache-Control": "no-store" } },
    ),
    request,
  );
}

export async function OPTIONS(request: Request) {
  return bridgePreflightResponse(request);
}
