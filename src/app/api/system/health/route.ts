import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { query } from "@/lib/db/client";
import { getStorageService } from "@/lib/storage";
import { getCleanupStatus } from "@/lib/db/cleanup-lock";
import { withTimeout } from "@/lib/db/with-timeout";
import { logger } from "@/lib/logging/logger";
import { version as appVersion } from "../../../../../package.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function probeDatabase(): Promise<{ connected: boolean; latencyMs: number; error?: string }> {
  const startedAt = Date.now();
  try {
    await withTimeout(query(`SELECT 1`), 8_000, "system/health:postgresql");
    return { connected: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    logger.error("PostgreSQL health probe failed", { error: error instanceof Error ? error.message : "unknown" });
    return { connected: false, latencyMs: Date.now() - startedAt, error: "PostgreSQL health probe failed." };
  }
}

export async function GET(request: Request) {
  return apiRoute(request, async (requestId) => {
    await requireAdminRequest(request, "read_files");
    const [database, blob, cleanup] = await Promise.all([
      probeDatabase(),
      getStorageService().healthCheck(),
      withTimeout(getCleanupStatus(), 8_000, "system/health:cleanup").catch(() => null),
    ]);
    const degraded = !database.connected || !blob.reachable;
    return success({
      status: degraded ? "degraded" : "healthy",
      version: appVersion,
      checkedAt: new Date().toISOString(),
      services: {
        application: { status: "healthy" },
        database: { status: database.connected ? "healthy" : "degraded", provider: "postgresql", latencyMs: database.latencyMs, ...(database.error ? { error: database.error } : {}) },
        blobStorage: {
          status: blob.reachable ? "healthy" : "degraded",
          latencyMs: blob.latencyMs,
          checkedAt: blob.checkedAt,
          authMode: blob.authMode ?? null,
          configured: blob.configured ?? (blob.authMode === "token" || blob.authMode === "oidc"),
          provider: "vercel-private-blob",
          storeId: blob.storeId ?? null,
          ...(blob.missingConfiguration?.length ? { missingConfiguration: blob.missingConfiguration } : {}),
          ...(blob.errorCode ? { errorCode: blob.errorCode } : {}),
          ...(blob.errorName ? { errorName: blob.errorName } : {}),
          ...(blob.error ? { error: blob.error } : {}),
          ...(blob.hint ? { hint: blob.hint } : {}),
        },
        authentication: { status: database.connected ? "healthy" : "degraded", provider: "first-party-password-sessions" },
        scheduledCleanup: { status: cleanup?.lastError ? "degraded" : "healthy", lastRunAt: cleanup?.completedAt ?? null, lastSummary: cleanup?.lastSummary ?? null, lastError: cleanup?.lastError ?? null },
      },
    }, requestId);
  }, { route: "system/health" });
}
