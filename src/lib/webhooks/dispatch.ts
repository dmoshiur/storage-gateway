import "server-only";

import { createHmac, randomUUID } from "node:crypto";
import type { WebhookEvent } from "@/types/webhook";
import { getWebhooksForEvent, recordDelivery, type DispatchableWebhook } from "@/lib/webhooks/store";
import { logger } from "@/lib/logging/logger";

const DELIVERY_TIMEOUT_MS = 10_000;

export interface WebhookPayload {
  id: string;
  event: WebhookEvent;
  createdAt: string;
  data: Record<string, unknown>;
}

function signPayload(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

async function deliverOnce(webhook: DispatchableWebhook, payload: WebhookPayload): Promise<void> {
  const body = JSON.stringify(payload);
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const response = await fetch(webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Event": payload.event,
        "X-Webhook-Id": payload.id,
        "X-Webhook-Signature": `sha256=${signPayload(webhook.secret, body)}`,
        "X-Webhook-Timestamp": payload.createdAt,
        "User-Agent": "NGO-File-Cloud-Webhooks/1.0",
      },
      body,
      signal: controller.signal,
    });
    const durationMs = Date.now() - startedAt;
    await recordDelivery({
      webhookId: webhook.id,
      event: payload.event,
      status: response.ok ? "success" : "failed",
      statusCode: response.status,
      durationMs,
      error: response.ok ? null : `Endpoint responded with HTTP ${response.status}.`,
    });
  } catch (error) {
    await recordDelivery({
      webhookId: webhook.id,
      event: payload.event,
      status: "failed",
      statusCode: null,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message.slice(0, 300) : "Delivery failed.",
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fire-and-forget fan-out. Dispatch never throws and never blocks the
 * triggering request: failures are recorded as delivery history.
 */
export function emitWebhookEvent(event: WebhookEvent, data: Record<string, unknown>): void {
  const payload: WebhookPayload = { id: randomUUID(), event, createdAt: new Date().toISOString(), data };
  void (async () => {
    try {
      const webhooks = await getWebhooksForEvent(event);
      await Promise.allSettled(webhooks.map((webhook) => deliverOnce(webhook, payload)));
    } catch (error) {
      logger.error("Webhook fan-out failed", { event, error: error instanceof Error ? error.message : "unknown" });
    }
  })();
}

/** Synchronous single delivery used by the "send test event" flow. */
export async function sendTestEvent(webhook: DispatchableWebhook): Promise<{ ok: boolean; statusCode: number | null }> {
  const payload: WebhookPayload = {
    id: randomUUID(),
    event: "file.uploaded",
    createdAt: new Date().toISOString(),
    data: { test: true, message: "This is a test delivery from NGO File Cloud." },
  };
  const body = JSON.stringify(payload);
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const response = await fetch(webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Event": "file.uploaded",
        "X-Webhook-Id": payload.id,
        "X-Webhook-Signature": `sha256=${signPayload(webhook.secret, body)}`,
        "X-Webhook-Timestamp": payload.createdAt,
        "User-Agent": "NGO-File-Cloud-Webhooks/1.0",
      },
      body,
      signal: controller.signal,
    });
    await recordDelivery({
      webhookId: webhook.id,
      event: "file.uploaded",
      status: response.ok ? "success" : "failed",
      statusCode: response.status,
      durationMs: Date.now() - startedAt,
      error: response.ok ? null : `Endpoint responded with HTTP ${response.status}.`,
    });
    return { ok: response.ok, statusCode: response.status };
  } catch (error) {
    await recordDelivery({
      webhookId: webhook.id,
      event: "file.uploaded",
      status: "failed",
      statusCode: null,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message.slice(0, 300) : "Delivery failed.",
    });
    return { ok: false, statusCode: null };
  } finally {
    clearTimeout(timer);
  }
}
