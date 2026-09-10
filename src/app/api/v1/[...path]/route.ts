import { bridgeRouteNotAtGateway } from "@/lib/api/bridge-route-not-at-gateway";

export const runtime = "nodejs";

/**
 * API bridge routes (`/api/v1/*`, especially `/api/v1/storage/upload`) are owned
 * by the FastAPI bridge, not by this Next.js gateway. This catch-all keeps a
 * misconfigured integration request from returning the default Next.js HTML 404
 * page and instead returns the standard JSON error envelope with guidance.
 */
export async function GET(request: Request) {
  return bridgeRouteNotAtGateway(request);
}

export async function POST(request: Request) {
  return bridgeRouteNotAtGateway(request);
}

export async function PUT(request: Request) {
  return bridgeRouteNotAtGateway(request);
}

export async function PATCH(request: Request) {
  return bridgeRouteNotAtGateway(request);
}

export async function DELETE(request: Request) {
  return bridgeRouteNotAtGateway(request);
}

export async function OPTIONS(request: Request) {
  return bridgeRouteNotAtGateway(request);
}

export async function HEAD(request: Request) {
  return bridgeRouteNotAtGateway(request);
}
