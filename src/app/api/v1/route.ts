import { bridgeRouteNotAtGateway } from "@/lib/api/bridge-route-not-at-gateway";

export const runtime = "nodejs";

/**
 * `/api/v1` by itself is also not a gateway route. Keep the JSON diagnostic
 * behavior consistent for callers that omit the full bridge subpath.
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
