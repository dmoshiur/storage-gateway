import { NextResponse } from "next/server";
import { apiRoute } from "@/lib/api/route";
import { bridgePreflightResponse, withBridgeCors } from "@/lib/bridge/upload";
import { readBlobStoreConfig } from "@/lib/env";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/request-auth";
import { version as appVersion } from "../../../../../package.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function blobConfigured(): boolean {
  return readBlobStoreConfig().ok;
}

/**
 * Unauthenticated bridge liveness probe for gramunnayan.com.
 *
 * Integrations point their storage URL at this same Vercel app and check
 * `GET <app>/api/v1/health` before uploading.
 */
export async function GET(request: Request) {
  const response = await apiRoute(request, async (requestId) => {
    enforceRateLimit(`v1:health:${getClientIp(request)}`, 120);
    return NextResponse.json(
      {
        status: "ok",
        service: "NGO File Cloud",
        bridge: "ready",
        mode: "embedded",
        version: appVersion,
        auth: "bearer|dual-token",
        blobConfigured: blobConfigured(),
      },
      { status: 200, headers: { "X-Request-Id": requestId, "Cache-Control": "no-store" } },
    );
  }, { route: "v1/health" });
  return withBridgeCors(response, request);
}

export async function OPTIONS(request: Request) {
  return bridgePreflightResponse(request);
}
