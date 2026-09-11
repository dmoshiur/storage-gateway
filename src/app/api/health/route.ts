import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { query } from "@/lib/db/client";
import { withTimeout } from "@/lib/db/with-timeout";
import { getStorageService } from "@/lib/storage";
import type { StorageHealth } from "@/lib/storage/storage-service";
import { logger } from "@/lib/logging/logger";
import { version as appVersion } from "../../../../package.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface DatabaseProbe {
  connected: boolean;
  latencyMs: number;
  error?: string;
}

async function probeDatabase(): Promise<DatabaseProbe> {
  const startedAt = Date.now();
  try {
    await withTimeout(query("SELECT 1"), 8_000, "health:postgresql");
    return { connected: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    logger.error("PostgreSQL health probe failed", { error: error instanceof Error ? error.message : "unknown" });
    return { connected: false, latencyMs: Date.now() - startedAt, error: "PostgreSQL health probe failed." };
  }
}

async function probeBlob(): Promise<StorageHealth> {
  try {
    // `healthCheck` never throws for expected Blob failures: it reports the
    // resolved auth mode, the exact missing configuration, or the real SDK
    // error. This catch only guards against an unexpected defect.
    return await getStorageService().healthCheck();
  } catch (error) {
    const name = error instanceof Error && error.name ? error.name : "Error";
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Vercel Blob health probe threw unexpectedly", { errorName: name, error: message });
    return {
      reachable: false,
      configured: false,
      latencyMs: 0,
      checkedAt: new Date().toISOString(),
      error: `Vercel Blob health probe failed (${name}): ${message}`,
      errorCode: "BLOB_PROBE_THREW",
      errorName: name,
      authMode: "none",
    };
  }
}

/**
 * Authenticated application health check. Dependency state is probed for real;
 * this endpoint never reports a configured or reachable service merely because
 * the Next.js process is running.
 */
export async function GET(request: Request) {
  return apiRoute(request, async (requestId) => {
    await requireAdminRequest(request, "read_files");
    const checkedAt = new Date().toISOString();
    const [database, blob] = await Promise.all([probeDatabase(), probeBlob()]);
    const operational = database.connected && blob.reachable;

    return success({
      systemStatus: operational ? "operational" : "degraded",
      gateway: { runtime: "nodejs", uptimeSeconds: Math.round(process.uptime()), checkedAt },
      bridge: {
        mode: "embedded",
        endpoint: "/api/v1",
        status: operational ? "healthy" : "degraded",
      },
      database: {
        provider: "postgresql",
        status: database.connected ? "healthy" : "degraded",
        latencyMs: database.latencyMs,
        ...(database.error ? { error: database.error } : {}),
      },
      storage: {
        provider: "vercel-private-blob",
        configured: blob.configured ?? (blob.authMode === "token" || blob.authMode === "oidc"),
        status: blob.reachable ? "healthy" : "degraded",
        reachable: blob.reachable,
        latencyMs: blob.latencyMs,
        authMode: blob.authMode,
        storeId: blob.storeId ?? null,
        ...(blob.missingConfiguration?.length ? { missingConfiguration: blob.missingConfiguration } : {}),
        ...(blob.errorCode ? { errorCode: blob.errorCode } : {}),
        ...(blob.errorName ? { errorName: blob.errorName } : {}),
        ...(blob.error ? { error: blob.error } : {}),
        ...(blob.hint ? { hint: blob.hint } : {}),
      },
      version: appVersion,
      checkedAt,
    }, requestId);
  }, { route: "health" });
}
