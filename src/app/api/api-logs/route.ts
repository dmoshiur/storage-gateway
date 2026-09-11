import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { toServiceFailure } from "@/lib/api/failures";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { getRecentUploadLogs } from "@/lib/db/api-metrics";

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
    try {
      return success({ logs: await getRecentUploadLogs(limit) }, requestId);
    } catch (error) {
      throw toServiceFailure({
        status: 503,
        code: "API_ACTIVITY_UNAVAILABLE",
        message: "API upload activity could not be read from PostgreSQL. Please retry shortly.",
        cause: error,
        operation: "api-logs/list",
        area: "database",
        requestId,
      });
    }
  }, { route: "api-logs" });
}
