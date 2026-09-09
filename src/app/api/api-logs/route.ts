import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { getRecentUploadLogs } from "@/lib/firestore/api-metrics";

export const runtime = "nodejs";

/**
 * Recent API (bridge) upload attempts for the dashboard's "API Upload
 * Activity" widget. The bridge records both successes and failures, so a
 * rejected gramunnayan.com request is visible here with its failure code.
 */
export async function GET(request: Request) {
  return apiRoute(request, async (requestId) => {
    await requireAdminRequest(request, "read_files");
    const requested = Number(new URL(request.url).searchParams.get("limit") ?? 5);
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(50, Math.trunc(requested)) : 5;
    return success({ logs: await getRecentUploadLogs(limit) }, requestId);
  }, { route: "api-logs" });
}
