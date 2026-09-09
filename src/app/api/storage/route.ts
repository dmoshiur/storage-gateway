import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { getStorageStats } from "@/lib/firestore/stats";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "read_files");
    enforceRateLimit(`storage:${actor.uid}`, 120);
    return success({ stats: await getStorageStats() }, requestId);
  }, { route: "storage" });
}
