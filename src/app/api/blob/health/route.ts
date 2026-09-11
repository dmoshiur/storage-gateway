import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { parseQuery } from "@/lib/api/body";
import { z } from "zod";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { getStorageService } from "@/lib/storage";
import { describeBlobStoreConfiguration } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const healthQuerySchema = z.object({
  /**
   * `deep=true` performs a real write → read → delete round-trip in the private
   * store. It is the strongest proof that the deployment can use Vercel Blob.
   */
  deep: z.enum(["true", "false"]).optional().default("false"),
});

/**
 * Server-side Vercel Private Blob health check.
 *
 * Reports the resolved authentication mode, which environment variables are
 * present (names and booleans only — never values), the exact missing
 * configuration when something is absent, and the real Vercel Blob error when
 * the store rejects the request. There is no mock or filesystem fallback here:
 * the probe always talks to the configured Blob store.
 *
 * `GET /api/blob/health`         → configuration + authenticated list probe
 * `GET /api/blob/health?deep=true` → adds a real put/head/get/delete round-trip
 *
 * Admin-only. Response bodies never contain credentials or signed URLs.
 */
export async function GET(request: Request) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "read_files");
    const query = parseQuery(
      Object.fromEntries(new URL(request.url).searchParams.entries()),
      healthQuerySchema,
    );

    const configuration = describeBlobStoreConfiguration();
    const storage = getStorageService();

    if (query.deep === "false") {
      enforceRateLimit(`blob:health:${actor.uid}`, 60);
      const health = await storage.healthCheck();
      return success(
        {
          provider: "vercel-private-blob",
          status: health.reachable ? "healthy" : "degraded",
          checkedAt: health.checkedAt,
          configuration,
          probe: {
            kind: "list",
            reachable: health.reachable,
            latencyMs: health.latencyMs,
            objectsVisible: health.probe?.objectsVisible ?? null,
          },
          error: health.error ?? null,
          errorCode: health.errorCode ?? null,
          errorName: health.errorName ?? null,
          hint: health.hint ?? null,
          authMode: health.authMode ?? configuration.authMode,
          storeId: health.storeId ?? configuration.storeId,
        },
        requestId,
      );
    }

    // Deep probes mutate the store, so they are rate limited harder.
    enforceRateLimit(`blob:health:deep:${actor.uid}`, 6);
    const health = await storage.deepHealthCheck();
    return success(
      {
        provider: "vercel-private-blob",
        status: health.reachable ? "healthy" : "degraded",
        checkedAt: health.checkedAt,
        configuration,
        probe: {
          kind: "put-head-get-delete",
          reachable: health.reachable,
          latencyMs: health.latencyMs,
          steps: health.deepCheck?.steps ?? [],
          cleanedUp: health.deepCheck?.cleanedUp ?? false,
          pathname: health.deepCheck?.pathname ?? null,
        },
        error: health.error ?? null,
        errorCode: health.errorCode ?? null,
        errorName: health.errorName ?? null,
        hint: health.hint ?? null,
        authMode: health.authMode ?? configuration.authMode,
        storeId: health.storeId ?? configuration.storeId,
      },
      requestId,
    );
  }, { route: "blob/health" });
}
