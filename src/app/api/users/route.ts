import { z } from "zod";
import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { parseJson, parseQuery } from "@/lib/api/body";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { inviteUser, listManagedUsers } from "@/lib/db/users";
import { writeAuditLogSafely, auditActorFrom } from "@/lib/db/audit";
import { createUserSchema } from "@/lib/validation/schemas";

export const runtime = "nodejs";

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
    // Server-side authorization: only a signed-in admin may create accounts,
    // regardless of what the browser UI allows. `mutate: true` also enforces
    // the same-origin check against CSRF.
    const actor = await requireAdminRequest(request, "manage_users", true);
    enforceRateLimit(`users:create:${actor.uid}`, 20);

    // Zod validates email, password policy and role before any database work.
    // A failure here now returns the specific reason (see lib/api/validation).
    const input = await parseJson(request, createUserSchema);

    const user = await inviteUser(input);

    // The audit entry records who was created and by whom — never the password.
    await writeAuditLogSafely({
      action: "USER_INVITED",
      actor: auditActorFrom(actor),
      details: { userId: user.uid, email: user.email, role: user.role, status: user.status },
      requestId,
    });
    return success({ user }, requestId, 201);
  }, { route: "users/create" });
}
