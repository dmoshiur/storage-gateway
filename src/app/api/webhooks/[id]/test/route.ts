import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { ApiError } from "@/lib/api/errors";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { getWebhookWithSecret } from "@/lib/webhooks/store";
import { sendTestEvent } from "@/lib/webhooks/dispatch";
import { writeAuditLogSafely, auditActorFrom } from "@/lib/db/audit";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "manage_webhooks", true);
    enforceRateLimit(`webhooks:test:${actor.uid}`, 20);
    const id = (await context.params).id;
    if (!id || id.length > 200) throw new ApiError(400, "VALIDATION_ERROR", "The webhook id is invalid.");
    const webhook = await getWebhookWithSecret(id);
    if (!webhook) throw new ApiError(404, "WEBHOOK_NOT_FOUND", "The webhook was not found.");
    const result = await sendTestEvent(webhook);
    await writeAuditLogSafely({
      action: "WEBHOOK_TESTED",
      actor: auditActorFrom(actor),
      details: { webhookId: id, ok: result.ok },
      requestId,
    });
    return success({ delivered: result.ok, statusCode: result.statusCode }, requestId);
  }, { route: "webhooks/test" });
}
