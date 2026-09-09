import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { parseQuery } from "@/lib/api/body";
import { requireCronSecret } from "@/lib/security/request-auth";
import { cleanupQuerySchema } from "@/lib/validation/schemas";
import { runCleanup } from "@/lib/cleanup/run-cleanup";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Vercel Cron invokes this with Authorization: Bearer $CRON_SECRET. */
async function cleanup(request: Request) {
  return apiRoute(request, async (requestId) => {
    requireCronSecret(request);
    const query = parseQuery(Object.fromEntries(new URL(request.url).searchParams.entries()), cleanupQuerySchema);
    const summary = await runCleanup({ dryRun: query.dryRun === "true" });
    return success(summary, requestId, summary.lockAcquired ? 200 : 202);
  }, { route: "cron/cleanup" });
}

export async function GET(request: Request) { return cleanup(request); }
export async function POST(request: Request) { return cleanup(request); }
