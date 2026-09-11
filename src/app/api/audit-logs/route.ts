import { z } from "zod";
import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { parseQuery } from "@/lib/api/body";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { listAuditLogs } from "@/lib/db/audit";

export const runtime = "nodejs";

const querySchema = z.object({
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(8).max(200).optional(),
});

export async function GET(request: Request) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "view_audit");
    enforceRateLimit(`audit:${actor.uid}`, 60);
    const query = parseQuery(Object.fromEntries(new URL(request.url).searchParams.entries()), querySchema);
    return success(await listAuditLogs(query.pageSize, query.cursor), requestId);
  }, { route: "audit-logs" });
}
