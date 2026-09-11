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
    return await getStorageService().healthCheck();
  } catch (error) {
    logger.error("Vercel Blob health probe failed", { error: error instanceof Error ? error.message : "unknown" });
    return {
      reachable: false,
      latencyMs: 0,
      checkedAt: new Date().toISOString(),
      error: "Vercel Blob health probe failed.",
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
        configured: blob.authMode === "token" || blob.authMode === "oidc",
        status: blob.reachable ? "healthy" : "degraded",
        reachable: blob.reachable,
        latencyMs: blob.latencyMs,
        authMode: blob.authMode,
        ...(blob.error ? { error: blob.error } : {}),
      },
      version: appVersion,
      checkedAt,
    }, requestId);
  }, { route: "health" });
}
