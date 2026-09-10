import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { getAdminDb } from "@/lib/firebase/admin";
import { getStorageService } from "@/lib/storage";
import { getCleanupStatus } from "@/lib/firestore/cleanup-lock";
import { version as appVersion } from "../../../../../package.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function probeDatabase(): Promise<{ connected: boolean; latencyMs: number }> {
  const startedAt = Date.now();
  try {
    await getAdminDb().collection("system").doc("health").get();
    return { connected: true, latencyMs: Date.now() - startedAt };
  } catch {
    return { connected: false, latencyMs: Date.now() - startedAt };
  }
}

export async function GET(request: Request) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "read_files");
    enforceRateLimit(`system:health:${actor.uid}`, 30);
    const [database, blob, cleanup] = await Promise.all([
      probeDatabase(),
      getStorageService().healthCheck(),
      getCleanupStatus().catch(() => null),
    ]);
    const degraded = !database.connected || !blob.reachable;
    return success({
      status: degraded ? "degraded" : "healthy",
      version: appVersion,
      checkedAt: new Date().toISOString(),
      services: {
        application: { status: "healthy" },
        database: { status: database.connected ? "healthy" : "degraded", latencyMs: database.latencyMs },
        blobStorage: { status: blob.reachable ? "healthy" : "degraded", latencyMs: blob.latencyMs, checkedAt: blob.checkedAt },
        authentication: { status: "healthy", provider: "firebase-auth" },
        scheduledCleanup: {
          status: cleanup?.lastError ? "degraded" : "healthy",
          lastRunAt: cleanup?.completedAt ?? null,
          lastSummary: cleanup?.lastSummary ?? null,
          lastError: cleanup?.lastError ?? null,
        },
      },
    }, requestId);
  }, { route: "system/health" });
}
