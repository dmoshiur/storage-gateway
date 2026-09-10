import { bridgeRouteNotAtGateway } from "@/lib/api/bridge-route-not-at-gateway";

export const runtime = "nodejs";

/**
 * Catch-all for unknown `/api/v1/*` subpaths. The embedded bridge serves the
 * documented routes (`/api/v1/storage/upload`, `/api/v1/health`, …) directly;
 * anything else lands here and receives the standard JSON error envelope with
 * guidance instead of the default Next.js HTML 404 page.
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
