import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { ApiError } from "@/lib/api/errors";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { rotateWebhookSecret } from "@/lib/webhooks/store";
import { writeAuditLogSafely, auditActorFrom } from "@/lib/firestore/audit";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "manage_webhooks", true);
    enforceRateLimit(`webhooks:rotate:${actor.uid}`, 20);
    const id = (await context.params).id;
    if (!id || id.length > 200) throw new ApiError(400, "VALIDATION_ERROR", "The webhook id is invalid.");
    const secret = await rotateWebhookSecret(id);
    await writeAuditLogSafely({
      action: "WEBHOOK_UPDATED",
      actor: auditActorFrom(actor),
      details: { webhookId: id, rotated: true },
    });
    return success({ secret }, requestId);
  }, { route: "webhooks/rotate" });
}
