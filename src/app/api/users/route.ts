import { z } from "zod";
import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { parseJson, parseQuery } from "@/lib/api/body";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { inviteUser, listManagedUsers } from "@/lib/db/users";
import { writeAuditLogSafely, auditActorFrom } from "@/lib/db/audit";
import { ROLES } from "@/types/auth";

export const runtime = "nodejs";

const createSchema = z.object({ email: z.string().trim().email().max(256), role: z.enum(ROLES), displayName: z.string().trim().max(120).optional(), password: z.string().min(12).max(512).optional() });
const listSchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) });

export async function GET(request: Request) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "manage_users");
    enforceRateLimit(`users:list:${actor.uid}`, 60);
    const input = parseQuery(Object.fromEntries(new URL(request.url).searchParams.entries()), listSchema);
    return success({ users: await listManagedUsers(input.limit) }, requestId);
  }, { route: "users/list" });
}

export async function POST(request: Request) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "manage_users", true);
    enforceRateLimit(`users:create:${actor.uid}`, 20);
    const input = await parseJson(request, createSchema);
    const user = await inviteUser(input);
    await writeAuditLogSafely({ action: "USER_INVITED", actor: auditActorFrom(actor), details: { userId: user.uid, email: user.email, role: user.role }, requestId });
    return success({ user }, requestId, 201);
  }, { route: "users/create" });
}
