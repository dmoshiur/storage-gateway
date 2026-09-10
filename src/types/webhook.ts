export const WEBHOOK_EVENTS = [
  "file.uploaded",
  "file.updated",
  "file.downloaded",
  "file.trashed",
  "file.restored",
  "file.deleted",
  "file.expiring",
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export interface WebhookRecord {
  id: string;
  name: string;
  url: string;
  events: WebhookEvent[];
  enabled: boolean;
  lastTriggeredAt: string | null;
  lastStatus: "success" | "failed" | null;
  failureCount: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  event: WebhookEvent;
  status: "success" | "failed";
  statusCode: number | null;
  durationMs: number;
  error: string | null;
  createdAt: string;
}
