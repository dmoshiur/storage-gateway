import { z } from "zod";
import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { parseJson, parseQuery } from "@/lib/api/body";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { listNotifications, markAllNotificationsRead, markNotificationRead } from "@/lib/db/notifications";

export const runtime = "nodejs";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  unreadOnly: z.enum(["true", "false"]).optional().default("false"),
});

const readSchema = z.object({
  id: z.string().min(1).max(200).optional(),
  all: z.boolean().optional(),
}).refine((data) => data.id || data.all, "Provide an id or all=true.");

export async function GET(request: Request) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "read_files");
    enforceRateLimit(`notifications:list:${actor.uid}`, 120);
    const query = parseQuery(Object.fromEntries(new URL(request.url).searchParams.entries()), listQuerySchema);
    const result = await listNotifications({ limit: query.limit, unreadOnly: query.unreadOnly === "true" });
    return success(result, requestId);
  }, { route: "notifications/list" });
}

export async function POST(request: Request) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "read_files", true);
    enforceRateLimit(`notifications:read:${actor.uid}`, 120);
    const input = await parseJson(request, readSchema);
    if (input.all) {
      const marked = await markAllNotificationsRead();
      return success({ marked }, requestId);
    }
    await markNotificationRead(input.id!);
    return success({ marked: 1 }, requestId);
  }, { route: "notifications/read" });
}
