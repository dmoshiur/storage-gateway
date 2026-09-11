import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { getStorageStats } from "@/lib/db/stats";
import { getApiRequestTotals } from "@/lib/db/api-metrics";
import { getStorageService } from "@/lib/storage/index";
import type { StorageHealth } from "@/lib/storage/storage-service";
import { toServiceFailure } from "@/lib/api/failures";
import { logger } from "@/lib/logging/logger";

export const runtime = "nodejs";

/**
 * Private Blob store connectivity check. Every failure mode — missing
 * credentials, DNS/network errors, timeouts — resolves to `reachable: false`
 * so the dashboard can never crash on it.
 */
async function checkBlobConnectivity(): Promise<StorageHealth> {
  try {
    return await getStorageService().healthCheck();
  } catch (error) {
    logger.error("Vercel Blob health check failed", { error: error instanceof Error ? error.message : "unknown" });
    return {
      reachable: false,
      latencyMs: 0,
      checkedAt: new Date().toISOString(),
      error: "Vercel Blob health check failed.",
      authMode: "none",
    };
  }
}

export async function GET(request: Request) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "read_files");
    enforceRateLimit(`storage:${actor.uid}`, 120);

    let stats: Awaited<ReturnType<typeof getStorageStats>>;
    let apiRequests: Awaited<ReturnType<typeof getApiRequestTotals>>;
    let blob: StorageHealth;
    try {
      [stats, blob, apiRequests] = await Promise.all([
        getStorageStats(),
        checkBlobConnectivity(),
        getApiRequestTotals(),
      ]);
    } catch (error) {
      throw toServiceFailure({
        status: 503,
        code: "STORAGE_METRICS_UNAVAILABLE",
        message: "Storage metrics could not be read from PostgreSQL. Please retry shortly.",
        cause: error,
        operation: "storage/metrics",
        area: "database",
        requestId,
      });
    }
    return success({ stats, blob, apiRequests }, requestId);
  }, { route: "storage" });
}
