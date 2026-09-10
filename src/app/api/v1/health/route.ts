import { NextResponse } from "next/server";
import { requestIdFrom } from "@/lib/api/response";
import { bridgePreflightResponse, withBridgeCors } from "@/lib/bridge/upload";
import { version as appVersion } from "../../../../../package.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function r2Configured(): boolean {
  return Boolean(
    (process.env.R2_ENDPOINT ?? "").trim() &&
      (process.env.R2_ACCESS_KEY_ID ?? "").trim() &&
      (process.env.R2_SECRET_ACCESS_KEY ?? "").trim() &&
      (process.env.R2_BUCKET_NAME ?? "").trim(),
  );
}

/**
 * Unauthenticated bridge liveness probe for gramunnayan.com.
 *
 * This is the single-deployment successor to the standalone bridge's
 * `GET /health`: integrations point `AM_STORAGE_BRIDGE_URL` at this same
 * Vercel app and check `GET <app>/api/v1/health` before uploading. The plain
 * (unenveloped) shape mirrors the historical bridge response.
 */
export async function GET(request: Request) {
  const requestId = requestIdFrom(request);
  return withBridgeCors(
    NextResponse.json(
      {
        status: "ok",
        service: "AM Storage Company",
        bridge: "ready",
        mode: "embedded",
        version: appVersion,
        auth: "dual-token|hmac|legacy",
        r2Configured: r2Configured(),
      },
      { status: 200, headers: { "X-Request-Id": requestId, "Cache-Control": "no-store" } },
    ),
    request,
  );
}

export async function OPTIONS(request: Request) {
  return bridgePreflightResponse(request);
}
