import "server-only";

import { query, toDate, SQL_NOW } from "@/lib/db/client";
import type { NotificationDocument, NotificationType, SerializedNotification } from "@/types/notification";

const RETENTION_LIMIT = 200;

function serialize(row: Record<string, unknown>): SerializedNotification {
  return {
    id: String(row.id),
    type: row.type as NotificationType,
    title: String(row.title ?? ""),
    message: String(row.message ?? ""),
    link: typeof row.link === "string" ? row.link : null,
    read: Boolean(row.read),
    createdAt: toDate(row.created_at)?.toISOString() ?? new Date(0).toISOString(),
  };
}

export async function createNotificationSafe(input: {
  type: NotificationType;
  title: string;
  message: string;
  link?: string | null;
  dedupeKey?: string;
}): Promise<void> {
  try {
    if (input.dedupeKey) {
      const existing = await query(`SELECT id FROM notifications WHERE dedupe_key = $1 AND read = false LIMIT 1`, [input.dedupeKey]);
      if (existing.rowCount) {
        await query(`UPDATE notifications SET title = $2, message = $3, created_at = ${SQL_NOW} WHERE id = $1`, [existing.rows[0].id, input.title, input.message]);
        return;
      }
    }
    await query(
      `INSERT INTO notifications(type, title, message, link, dedupe_key) VALUES ($1, $2, $3, $4, $5)`,
      [input.type, input.title, input.message, input.link ?? null, input.dedupeKey ?? null],
    );
    await query(`DELETE FROM notifications WHERE id IN (SELECT id FROM notifications ORDER BY created_at DESC LIMIT -1 OFFSET $1)`, [RETENTION_LIMIT]);
  } catch {
    // Notifications are observability and never break the triggering operation.
  }
}

export async function pruneNotifications(): Promise<number> {
  const result = await query<{ id: string }>(`DELETE FROM notifications WHERE id IN (SELECT id FROM notifications ORDER BY created_at DESC LIMIT -1 OFFSET $1) RETURNING id`, [RETENTION_LIMIT]);
  return result.rowCount ?? 0;
}

export async function listNotifications(input: { limit?: number; unreadOnly?: boolean } = {}): Promise<{ notifications: SerializedNotification[]; unreadCount: number }> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const where = input.unreadOnly ? "WHERE read = false" : "";
  const [result, unread] = await Promise.all([
    query(`SELECT id, type, title, message, link, read, created_at FROM notifications ${where} ORDER BY created_at DESC LIMIT $1`, [limit]),
    query<{ count: string }>(`SELECT count(*) AS count FROM notifications WHERE read = false`),
  ]);
  return { notifications: result.rows.map(serialize), unreadCount: Number(unread.rows[0]?.count ?? 0) };
}

export async function markNotificationRead(id: string): Promise<void> {
  await query(`UPDATE notifications SET read = true WHERE id = $1`, [id]);
}

export async function markAllNotificationsRead(): Promise<number> {
  const result = await query(`UPDATE notifications SET read = true WHERE read = false`);
  return result.rowCount ?? 0;
}

export type { NotificationDocument };
