import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { runCleanup } from "@/lib/cleanup/run-cleanup";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Admin-triggered cleanup uses the authenticated dashboard session, never the cron secret in the browser. */
export async function POST(request: Request) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "run_cleanup", true);
    enforceRateLimit(`cleanup:manual:${actor.uid}`, 5, 60 * 60 * 1000);
    return success(await runCleanup(), requestId);
  }, { route: "cleanup/manual" });
}
