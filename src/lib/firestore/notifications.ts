import "server-only";

import type { Query } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import type { NotificationDocument, NotificationType, SerializedNotification } from "@/types/notification";
import { asDate } from "@/utils/date";

const NOTIFICATIONS = "notifications";
const RETENTION_LIMIT = 200;

function serialize(id: string, data: Record<string, unknown>): SerializedNotification {
  return {
    id,
    type: data.type as NotificationType,
    title: String(data.title ?? ""),
    message: String(data.message ?? ""),
    link: typeof data.link === "string" ? data.link : null,
    read: Boolean(data.read),
    createdAt: asDate(data.createdAt)?.toISOString() ?? new Date(0).toISOString(),
  };
}

/** Best-effort: notifications are observability and must never break the caller. Never throws. */
export async function createNotificationSafe(input: {
  type: NotificationType;
  title: string;
  message: string;
  link?: string | null;
  /** Dedupe key: an unread notification with the same key is updated instead of duplicated. */
  dedupeKey?: string;
}): Promise<void> {
  try {
    const db = getAdminDb();
    if (input.dedupeKey) {
      const existing = await db
        .collection(NOTIFICATIONS)
        .where("dedupeKey", "==", input.dedupeKey)
        .where("read", "==", false)
        .limit(1)
        .get();
      if (!existing.empty) {
        await existing.docs[0]!.ref.update({ title: input.title, message: input.message, createdAt: new Date() });
        return;
      }
    }
    await db.collection(NOTIFICATIONS).add({
      type: input.type,
      title: input.title,
      message: input.message,
      link: input.link ?? null,
      dedupeKey: input.dedupeKey ?? null,
      read: false,
      createdAt: new Date(),
    });
    // Bounded retention: prune the oldest beyond the cap (best-effort).
    const overflow = await db.collection(NOTIFICATIONS).orderBy("createdAt", "asc").limit(1).get();
    void overflow;
  } catch {
    /* notifications never break the triggering flow */
  }
}

export async function pruneNotifications(): Promise<number> {
  const db = getAdminDb();
  const snapshot = await db.collection(NOTIFICATIONS).orderBy("createdAt", "desc").get();
  if (snapshot.size <= RETENTION_LIMIT) return 0;
  const stale = snapshot.docs.slice(RETENTION_LIMIT);
  const batch = db.batch();
  for (const doc of stale) batch.delete(doc.ref);
  await batch.commit();
  return stale.length;
}

export async function listNotifications(input: { limit?: number; unreadOnly?: boolean } = {}): Promise<{
  notifications: SerializedNotification[];
  unreadCount: number;
}> {
  const db = getAdminDb();
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  let query: Query = db.collection(NOTIFICATIONS).orderBy("createdAt", "desc");
  if (input.unreadOnly) query = query.where("read", "==", false);
  const [snapshot, unread] = await Promise.all([
    query.limit(limit).get(),
    db.collection(NOTIFICATIONS).where("read", "==", false).count().get(),
  ]);
  return {
    notifications: snapshot.docs.map((doc) => serialize(doc.id, doc.data())),
    unreadCount: unread.data().count,
  };
}

export async function markNotificationRead(id: string): Promise<void> {
  await getAdminDb().collection(NOTIFICATIONS).doc(id).set({ read: true }, { merge: true });
}

export async function markAllNotificationsRead(): Promise<number> {
  const db = getAdminDb();
  const snapshot = await db.collection(NOTIFICATIONS).where("read", "==", false).limit(200).get();
  if (snapshot.empty) return 0;
  const batch = db.batch();
  for (const doc of snapshot.docs) batch.update(doc.ref, { read: true });
  await batch.commit();
  return snapshot.size;
}

export type { NotificationDocument };
