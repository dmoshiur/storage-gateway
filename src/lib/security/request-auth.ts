import "server-only";

import { ApiError } from "@/lib/api/errors";
import { can, type Capability } from "@/lib/auth/authorization";
import { verifySessionCookie, SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { getRequiredSecret, constantTimeSecretEquals } from "@/lib/env";
import { hasBridgeCredentialHeaders, requireBridgeCredential } from "@/lib/bridge/auth";
import { requireScope, type ApiScope } from "@/lib/security/api-keys";
import type { IntegrationActor, RequestActor, SessionActor } from "@/types/auth";

export function getClientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? request.headers.get("x-real-ip") ?? "unknown";
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) throw new ApiError(403, "INVALID_ORIGIN", "This request was rejected for security reasons.");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
  if (!host || origin !== `${proto}://${host}`) throw new ApiError(403, "INVALID_ORIGIN", "This request was rejected for security reasons.");
}

export function sessionCookieFromRequest(request: Request): string | undefined {
  return request.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^;]+)`))?.[1];
}

export async function requireAdminRequest(request: Request, capability: Capability = "manage_files", mutate = false): Promise<SessionActor> {
  if (mutate) assertSameOrigin(request);
  const actor = await verifySessionCookie(sessionCookieFromRequest(request));
  if (!can(actor.role, capability)) throw new ApiError(403, "FORBIDDEN", "You do not have permission to perform this action.");
  return actor;
}

/** Validates a PostgreSQL-backed bridge key for internal server-to-server routes. */
export async function requireIntegrationKey(request: Request, requiredScope: ApiScope = "metadata:read"): Promise<IntegrationActor> {
  const credential = await requireBridgeCredential(request);
  requireScope(credential.scopes, requiredScope);
  return { uid: "website-integration", email: null, role: "viewer", type: "integration" };
}

export async function requireReadActor(request: Request, requiredScope: ApiScope = "files:read"): Promise<RequestActor> {
  if (hasBridgeCredentialHeaders(request)) {
    // Website integrations use the same PostgreSQL-backed, digest-verified
    // bridge keys as the /api/v1 surface; there is no static raw integration
    // secret fallback.
    const credential = await requireBridgeCredential(request);
    requireScope(credential.scopes, requiredScope);
    return { uid: "website-integration", email: null, role: "viewer", type: "integration" };
  }
  const actor = await verifySessionCookie(sessionCookieFromRequest(request));
  if (!can(actor.role, "read_files")) throw new ApiError(403, "FORBIDDEN", "You do not have permission to view files.");
  return actor;
}

export function requireCronSecret(request: Request): void {
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const expected = getRequiredSecret("CRON_SECRET");
  if (!constantTimeSecretEquals(supplied, expected)) throw new ApiError(401, "INVALID_CRON_AUTH", "The scheduled task is not authorized.");
}
