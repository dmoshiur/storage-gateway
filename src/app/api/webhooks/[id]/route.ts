import { z } from "zod";
import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { parseJson } from "@/lib/api/body";
import { ApiError } from "@/lib/api/errors";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { deleteWebhook, listDeliveries, updateWebhook } from "@/lib/webhooks/store";
import { writeAuditLogSafely, auditActorFrom } from "@/lib/firestore/audit";
import { WEBHOOK_EVENTS } from "@/types/webhook";

export const runtime = "nodejs";

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  url: z.string().trim().url().max(2048).refine((url) => url.startsWith("https://"), "Webhook URLs must use HTTPS.").optional(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length).optional(),
  enabled: z.boolean().optional(),
}).refine((data) => Object.keys(data).length > 0, "Provide at least one field to update.");

function routeId(value: string): string {
  if (!value || value.length > 200) throw new ApiError(400, "VALIDATION_ERROR", "The webhook id is invalid.");
  return value;
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "manage_webhooks");
    enforceRateLimit(`webhooks:deliveries:${actor.uid}`, 60);
    const id = routeId((await context.params).id);
    return success({ deliveries: await listDeliveries(id) }, requestId);
  }, { route: "webhooks/deliveries" });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "manage_webhooks", true);
    enforceRateLimit(`webhooks:update:${actor.uid}`, 60);
    const input = await parseJson(request, updateSchema);
    const webhook = await updateWebhook(routeId((await context.params).id), input);
    await writeAuditLogSafely({
      action: "WEBHOOK_UPDATED",
      actor: auditActorFrom(actor),
      details: { webhookId: webhook.id },
    });
    return success({ webhook }, requestId);
  }, { route: "webhooks/update" });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "manage_webhooks", true);
    enforceRateLimit(`webhooks:delete:${actor.uid}`, 30);
    const id = routeId((await context.params).id);
    await deleteWebhook(id);
    await writeAuditLogSafely({
      action: "WEBHOOK_DELETED",
      actor: auditActorFrom(actor),
      details: { webhookId: id },
    });
    return success({ deleted: true }, requestId);
  }, { route: "webhooks/delete" });
}
