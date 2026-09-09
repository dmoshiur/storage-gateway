import "server-only";

import { timingSafeEqual } from "node:crypto";
import { ApiError } from "@/lib/api/errors";
import { can, type Capability } from "@/lib/auth/authorization";
import { verifySessionCookie, SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { getRequiredSecret } from "@/lib/env";
import type { IntegrationActor, RequestActor, SessionActor } from "@/types/auth";

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function getClientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? request.headers.get("x-real-ip")
    ?? "unknown";
}

/** Same-origin guard for cookie-authenticated mutations; API-key callers are not browser-cookie flows. */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) throw new ApiError(403, "INVALID_ORIGIN", "This request was rejected for security reasons.");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
  if (!host || origin !== `${proto}://${host}`) {
    throw new ApiError(403, "INVALID_ORIGIN", "This request was rejected for security reasons.");
  }
}

export async function requireAdminRequest(request: Request, capability: Capability = "manage_files", mutate = false): Promise<SessionActor> {
  if (mutate) assertSameOrigin(request);
  const cookie = request.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^;]+)`))?.[1];
  const actor = await verifySessionCookie(cookie);
  if (!can(actor.role, capability)) throw new ApiError(403, "FORBIDDEN", "You do not have permission to perform this action.");
  return actor;
}

/** Server-to-server trust boundary for internal bridge calls. The raw key travels only over TLS between our own services. */
export function requireIntegrationKey(request: Request): IntegrationActor {
  const suppliedKey = request.headers.get("x-storage-gateway-key");
  if (!suppliedKey) {
    throw new ApiError(401, "UNAUTHENTICATED", "The integration credentials are missing.");
  }
  const expectedKey = getRequiredSecret("INTEGRATION_API_KEY");
  if (!secureEqual(suppliedKey, expectedKey)) {
    throw new ApiError(401, "INVALID_INTEGRATION_KEY", "The integration credentials are invalid.");
  }
  return { uid: "website-integration", email: null, role: "viewer", type: "integration" };
}

export async function requireReadActor(request: Request): Promise<RequestActor> {
  if (request.headers.get("x-storage-gateway-key")) return requireIntegrationKey(request);

  const cookie = request.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^;]+)`))?.[1];
  const actor = await verifySessionCookie(cookie);
  if (!can(actor.role, "read_files")) throw new ApiError(403, "FORBIDDEN", "You do not have permission to view files.");
  return actor;
}

export function requireCronSecret(request: Request): void {
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const expected = getRequiredSecret("CRON_SECRET");
  if (!secureEqual(bearer, expected)) throw new ApiError(401, "INVALID_CRON_AUTH", "The scheduled task is not authorized.");
}
