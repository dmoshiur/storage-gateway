import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { asDate } from "@/utils/date";

const LOCK_DOCUMENT = "cleanupLock";
const STALE_AFTER_MS = 20 * 60 * 1000;

export async function acquireCleanupLock(): Promise<boolean> {
  const db = getAdminDb();
  const reference = db.collection("system").doc(LOCK_DOCUMENT);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const data = snapshot.data();
    const startedAt = asDate(data?.startedAt);
    const active = data?.state === "running" && startedAt && Date.now() - startedAt.getTime() < STALE_AFTER_MS;
    if (active) return false;
    transaction.set(reference, { state: "running", startedAt: new Date(), completedAt: null, lastError: null }, { merge: true });
    return true;
  });
}

export async function releaseCleanupLock(summary: Record<string, unknown>, error?: string): Promise<void> {
  await getAdminDb().collection("system").doc(LOCK_DOCUMENT).set({
    state: "idle",
    completedAt: new Date(),
    lastSummary: summary,
    lastError: error ?? null,
  }, { merge: true });
}

export interface CleanupStatus {
  state: string;
  startedAt: string | null;
  completedAt: string | null;
  lastSummary: Record<string, unknown> | null;
  lastError: string | null;
}

export async function getCleanupStatus(): Promise<CleanupStatus> {
  const snapshot = await getAdminDb().collection("system").doc(LOCK_DOCUMENT).get();
  const data = snapshot.data();
  return {
    state: typeof data?.state === "string" ? data.state : "unknown",
    startedAt: asDate(data?.startedAt)?.toISOString() ?? null,
    completedAt: asDate(data?.completedAt)?.toISOString() ?? null,
    lastSummary: data?.lastSummary && typeof data.lastSummary === "object"
      ? data.lastSummary as Record<string, unknown>
      : null,
    lastError: typeof data?.lastError === "string" ? data.lastError : null,
  };
}
