import { z } from "zod";
import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { parseJson } from "@/lib/api/body";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { createWebhook, listWebhooks } from "@/lib/webhooks/store";
import { writeAuditLogSafely, auditActorFrom } from "@/lib/firestore/audit";
import { WEBHOOK_EVENTS } from "@/types/webhook";

export const runtime = "nodejs";

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  url: z.string().trim().url().max(2048).refine((url) => url.startsWith("https://"), "Webhook URLs must use HTTPS."),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length),
});

export async function GET(request: Request) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "manage_webhooks");
    enforceRateLimit(`webhooks:list:${actor.uid}`, 60);
    return success({ webhooks: await listWebhooks() }, requestId);
  }, { route: "webhooks/list" });
}

export async function POST(request: Request) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "manage_webhooks", true);
    enforceRateLimit(`webhooks:create:${actor.uid}`, 20);
    const input = await parseJson(request, createSchema);
    const { webhook, secret } = await createWebhook({ ...input, createdBy: actor.uid });
    await writeAuditLogSafely({
      action: "WEBHOOK_CREATED",
      actor: auditActorFrom(actor),
      details: { webhookId: webhook.id, url: webhook.url },
    });
    // The secret is shown exactly once.
    return success({ webhook, secret }, requestId, 201);
  }, { route: "webhooks/create" });
}
