import "server-only";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { toIso } from "@/utils/date";

const METRICS_COLLECTION = "apiMetrics";
const LOGS_COLLECTION = "apiUploadLogs";
/** Bounded retention for the small NGO deployment: keep the 50 newest entries. */
const MAX_UPLOAD_LOGS = 50;

export interface UploadLogEntry {
  keyId: string;
  filename: string;
  sizeBytes: number;
  status: "success" | "failed";
  failureCode: string | null;
  requestId: string;
  timestamp: string;
}

export interface RecentUploadLog {
  id: string;
  keyId: string;
  filename: string;
  sizeBytes: number;
  status: "success" | "failed";
  failureCode: string | null;
  requestId: string;
  timestamp: string;
}

function utcDayLabel(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function keyField(keyId: string): string {
  return /^[A-Za-z0-9_-]{1,80}$/.test(keyId) ? keyId : "legacy";
}

/**
 * Daily per-key request counter backing the dashboard's "API Requests" metric.
 * Observability only: a transient Firestore failure must never fail the
 * request it is attached to.
 */
export async function recordApiRequest(keyId: string): Promise<void> {
  const label = utcDayLabel(new Date());
  await getAdminDb().collection(METRICS_COLLECTION).doc(label).set({
    date: label,
    totalRequests: FieldValue.increment(1),
    [keyField(keyId)]: FieldValue.increment(1),
    updatedAt: new Date(),
  }, { merge: true });
}

/** Same as recordApiRequest but swallows every failure. */
export async function recordApiRequestSafe(keyId: string): Promise<void> {
  try {
    await recordApiRequest(keyId);
  } catch {
    // Metrics are best-effort observability; never propagate.
  }
}

export interface ApiRequestTotals {
  totalRequests: number;
  lastRequestDate: string | null;
}

/** Sum of recorded bridge hits over the lookback window (default 12 months). */
export async function getApiRequestTotals(lookbackDays = 366): Promise<ApiRequestTotals> {
  const startLabel = utcDayLabel(new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000));
  const snapshot = await getAdminDb().collection(METRICS_COLLECTION)
    .where("date", ">=", startLabel)
    .orderBy("date", "desc")
    .limit(400)
    .get();
  let totalRequests = 0;
  for (const doc of snapshot.docs) {
    totalRequests += Number(doc.data().totalRequests ?? 0);
  }
  return {
    totalRequests,
    lastRequestDate: snapshot.empty ? null : (String(snapshot.docs[0]!.data().date ?? null) || null),
  };
}

/**
 * Persists one bridge upload attempt (success or failure) for the dashboard's
 * "API Upload Activity" log, then prunes the collection back to its cap.
 */
export async function recordUploadLog(entry: UploadLogEntry): Promise<void> {
  const db = getAdminDb();
  await db.collection(LOGS_COLLECTION).doc().set({
    keyId: entry.keyId,
    filename: entry.filename,
    sizeBytes: entry.sizeBytes,
    status: entry.status,
    failureCode: entry.failureCode,
    requestId: entry.requestId,
    timestamp: new Date(entry.timestamp),
    updatedAt: new Date(),
  });

  try {
    const count = await db.collection(LOGS_COLLECTION).count().get();
    const overflow = (count.data().count ?? 0) - MAX_UPLOAD_LOGS;
    if (overflow > 0) {
      const oldest = await db.collection(LOGS_COLLECTION).orderBy("timestamp", "asc").limit(overflow).get();
      const batch = db.batch();
      for (const doc of oldest.docs) batch.delete(doc.ref);
      await batch.commit();
    }
  } catch {
    // Pruning is best-effort; a failure only means slightly more history kept.
  }
}

export async function getRecentUploadLogs(limit = 5): Promise<RecentUploadLog[]> {
  const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
  const snapshot = await getAdminDb().collection(LOGS_COLLECTION)
    .orderBy("timestamp", "desc")
    .limit(safeLimit)
    .get();
  return snapshot.docs.map((doc) => {
    const data = doc.data();
    const rawTimestamp = data.timestamp;
    const date = rawTimestamp instanceof Date ? rawTimestamp : new Date(String(data.timestamp ?? ""));
    return {
      id: doc.id,
      keyId: String(data.keyId ?? ""),
      filename: String(data.filename ?? "unknown"),
      sizeBytes: Number(data.sizeBytes ?? 0),
      status: data.status === "failed" ? "failed" : "success",
      failureCode: typeof data.failureCode === "string" ? data.failureCode : null,
      requestId: String(data.requestId ?? ""),
      timestamp: toIso(date) ?? "",
    };
  });
}
