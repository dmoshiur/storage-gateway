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
 * Initial Cloudflare R2 bucket connectivity check. Every failure mode —
 * missing R2 credentials, DNS/network errors, timeouts — resolves to
 * `reachable: false` so the dashboard can never crash on it.
 */
async function checkR2Connectivity(): Promise<StorageHealth> {
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
    // Each external dependency is isolated: Firestore degrades to fallback
    // metrics, R2 degrades to "unreachable", and metrics degrade to zero.
    const [statsResult, r2, apiRequests] = await Promise.all([
      getStorageStatsSafe(),
      checkR2Connectivity(),
      getApiRequestTotals().catch(() => ({ totalRequests: 0, lastRequestDate: null as string | null })),
    ]);
    return success({ stats: statsResult.stats, source: statsResult.source, r2, apiRequests }, requestId);
  }, { route: "storage" });
}
