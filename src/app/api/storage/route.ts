import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { getStorageStatsSafe } from "@/lib/firestore/stats";
import { getApiRequestTotals } from "@/lib/firestore/api-metrics";
import { getStorageService } from "@/lib/storage/index";
import type { StorageHealth } from "@/lib/storage/storage-service";

export const runtime = "nodejs";

/**
 * Private Blob store connectivity check. Every failure mode — missing
 * credentials, DNS/network errors, timeouts — resolves to
 * `reachable: false` so the dashboard can never crash on it.
 */
async function checkBlobConnectivity(): Promise<StorageHealth> {
  try {
    return await getStorageService().healthCheck();
  } catch {
    return { reachable: false, latencyMs: 0, checkedAt: new Date().toISOString() };
  }
}

export async function GET(request: Request) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "read_files");
    enforceRateLimit(`storage:${actor.uid}`, 120);
    // Each external dependency is isolated: Firestore returns explicitly
    // degraded metrics, Blob reports "unreachable", and request totals degrade
    // to zero without blocking the dashboard.
    const [statsResult, blob, apiRequests] = await Promise.all([
      getStorageStatsSafe(),
      checkBlobConnectivity(),
      getApiRequestTotals().catch(() => ({ totalRequests: 0, lastRequestDate: null as string | null })),
    ]);
    return success({ stats: statsResult.stats, source: statsResult.source, blob, apiRequests }, requestId);
  }, { route: "storage" });
}
