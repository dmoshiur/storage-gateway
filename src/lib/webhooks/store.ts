import "server-only";

import { randomBytes } from "node:crypto";
import { getAdminDb } from "@/lib/firebase/admin";
import { ApiError } from "@/lib/api/errors";
import type { WebhookDelivery, WebhookEvent, WebhookRecord } from "@/types/webhook";
import { asDate } from "@/utils/date";

const WEBHOOKS = "webhooks";
const DELIVERIES = "webhookDeliveries";

function serialize(id: string, data: Record<string, unknown>): WebhookRecord {
  return {
    id,
    name: String(data.name ?? ""),
    url: String(data.url ?? ""),
    events: Array.isArray(data.events) ? (data.events as WebhookEvent[]) : [],
    enabled: Boolean(data.enabled),
    lastTriggeredAt: asDate(data.lastTriggeredAt)?.toISOString() ?? null,
    lastStatus: data.lastStatus === "success" || data.lastStatus === "failed" ? data.lastStatus : null,
    failureCount: typeof data.failureCount === "number" ? data.failureCount : 0,
    createdAt: asDate(data.createdAt)?.toISOString() ?? new Date(0).toISOString(),
    updatedAt: asDate(data.updatedAt)?.toISOString() ?? new Date(0).toISOString(),
    createdBy: String(data.createdBy ?? ""),
  };
}

export async function listWebhooks(): Promise<WebhookRecord[]> {
  const snapshot = await getAdminDb().collection(WEBHOOKS).orderBy("createdAt", "desc").get();
  return snapshot.docs.map((doc) => serialize(doc.id, doc.data()));
}

export async function createWebhook(input: {
  name: string;
  url: string;
  events: WebhookEvent[];
  createdBy: string;
}): Promise<{ webhook: WebhookRecord; secret: string }> {
  const secret = `whsec_${randomBytes(24).toString("base64url")}`;
  const now = new Date();
  const ref = await getAdminDb().collection(WEBHOOKS).add({
    name: input.name.trim().slice(0, 80),
    url: input.url.trim(),
    events: input.events,
    enabled: true,
    // The secret signs every payload. It lives only in this server-side
    // collection (Firestore rules deny all client access) and is returned
    // exactly once at creation/rotation — never serialized again.
    secret,
    lastTriggeredAt: null,
    lastStatus: null,
    failureCount: 0,
    createdAt: now,
    updatedAt: now,
    createdBy: input.createdBy,
  });
  const snapshot = await ref.get();
  return { webhook: serialize(ref.id, snapshot.data() ?? {}), secret };
}

export async function updateWebhook(
  id: string,
  patch: { name?: string; url?: string; events?: WebhookEvent[]; enabled?: boolean },
): Promise<WebhookRecord> {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) updates.name = patch.name.trim().slice(0, 80);
  if (patch.url !== undefined) updates.url = patch.url.trim();
  if (patch.events !== undefined) updates.events = patch.events;
  if (patch.enabled !== undefined) {
    updates.enabled = patch.enabled;
    if (patch.enabled) updates.failureCount = 0;
  }
  const ref = getAdminDb().collection(WEBHOOKS).doc(id);
  await ref.set(updates, { merge: true });
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new ApiError(404, "WEBHOOK_NOT_FOUND", "The webhook was not found.");
  return serialize(id, snapshot.data() ?? {});
}

export async function deleteWebhook(id: string): Promise<void> {
  await getAdminDb().collection(WEBHOOKS).doc(id).delete();
}

export async function rotateWebhookSecret(id: string): Promise<string> {
  const secret = `whsec_${randomBytes(24).toString("base64url")}`;
  await getAdminDb().collection(WEBHOOKS).doc(id).set({
    secret,
    updatedAt: new Date(),
  }, { merge: true });
  return secret;
}

export async function getWebhookWithSecret(id: string): Promise<DispatchableWebhook | null> {
  const snapshot = await getAdminDb().collection(WEBHOOKS).doc(id).get();
  if (!snapshot.exists) return null;
  const data = snapshot.data() ?? {};
  if (typeof data.secret !== "string" || !data.secret) return null;
  return { id, url: String(data.url ?? ""), secret: data.secret };
}

export async function recordDelivery(input: {
  webhookId: string;
  event: WebhookEvent;
  status: "success" | "failed";
  statusCode: number | null;
  durationMs: number;
  error: string | null;
}): Promise<void> {
  const db = getAdminDb();
  await db.collection(DELIVERIES).add({ ...input, createdAt: new Date() });
  const ref = db.collection(WEBHOOKS).doc(input.webhookId);
  const snapshot = await ref.get();
  const failureCount = typeof snapshot.data()?.failureCount === "number" ? snapshot.data()!.failureCount as number : 0;
  await ref.set({
    lastTriggeredAt: new Date(),
    lastStatus: input.status,
    failureCount: input.status === "failed" ? failureCount + 1 : 0,
    // Auto-disable after 20 consecutive failures to protect the platform.
    ...(input.status === "failed" && failureCount + 1 >= 20 ? { enabled: false } : {}),
    updatedAt: new Date(),
  }, { merge: true });
}

export async function listDeliveries(webhookId: string, limit = 50): Promise<WebhookDelivery[]> {
  const snapshot = await getAdminDb()
    .collection(DELIVERIES)
    .where("webhookId", "==", webhookId)
    .orderBy("createdAt", "desc")
    .limit(Math.min(Math.max(limit, 1), 100))
    .get();
  return snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      webhookId: String(data.webhookId),
      event: data.event as WebhookEvent,
      status: data.status as "success" | "failed",
      statusCode: typeof data.statusCode === "number" ? data.statusCode : null,
      durationMs: typeof data.durationMs === "number" ? data.durationMs : 0,
      error: typeof data.error === "string" ? data.error : null,
      createdAt: asDate(data.createdAt)?.toISOString() ?? new Date(0).toISOString(),
    };
  });
}

export interface DispatchableWebhook {
  id: string;
  url: string;
  secret: string;
}

/** Webhooks subscribed to an event. Secrets are needed for signing; this stays server-side. */
export async function getWebhooksForEvent(event: WebhookEvent): Promise<DispatchableWebhook[]> {
  const snapshot = await getAdminDb()
    .collection(WEBHOOKS)
    .where("enabled", "==", true)
    .where("events", "array-contains", event)
    .get();
  return snapshot.docs
    .map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        url: String(data.url ?? ""),
        secret: typeof data.secret === "string" ? data.secret : "",
      };
    })
    .filter((webhook) => Boolean(webhook.url && webhook.secret));
}
