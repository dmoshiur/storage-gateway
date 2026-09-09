import "server-only";

import type { Query } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import type { AuditAction, AuditActor, AuditLogDocument, SerializedAuditLog } from "@/types/audit";
import { asDate } from "@/utils/date";
import { logger } from "@/lib/logging/logger";

export async function writeAuditLog(input: Omit<AuditLogDocument, "createdAt">): Promise<void> {
  await getAdminDb().collection("auditLogs").add({ ...input, createdAt: new Date() });
}

/** Object-store operations cannot be rolled back just because audit persistence is temporarily unavailable. */
export async function writeAuditLogSafely(input: Omit<AuditLogDocument, "createdAt">): Promise<void> {
  try {
    await writeAuditLog(input);
  } catch (error) {
    logger.error("Audit log write failed", {
      action: input.action,
      fileId: input.fileId,
      error: error instanceof Error ? error.message : "unknown",
    });
  }
}

function serialize(id: string, data: Record<string, unknown>): SerializedAuditLog {
  return {
    id,
    action: data.action as AuditAction,
    actor: data.actor as AuditActor,
    ...(typeof data.fileId === "string" ? { fileId: data.fileId } : {}),
    ...(typeof data.fileName === "string" ? { fileName: data.fileName } : {}),
    ...(data.details && typeof data.details === "object" ? { details: data.details as Record<string, string | number | boolean | null> } : {}),
    createdAt: asDate(data.createdAt)?.toISOString() ?? new Date(0).toISOString(),
  };
}

export async function listAuditLogs(pageSize = 50, cursor?: string): Promise<{ logs: SerializedAuditLog[]; nextCursor: string | null }> {
  const db = getAdminDb();
  let query: Query = db.collection("auditLogs").orderBy("createdAt", "desc");
  if (cursor) {
    const cursorSnapshot = await db.collection("auditLogs").doc(cursor).get();
    if (cursorSnapshot.exists) query = query.startAfter(cursorSnapshot);
  }
  const snapshots = await query.limit(pageSize + 1).get();
  const visible = snapshots.docs.slice(0, pageSize);
  return {
    logs: visible.map((snapshot) => serialize(snapshot.id, snapshot.data())),
    nextCursor: snapshots.docs.length > pageSize ? visible.at(-1)?.id ?? null : null,
  };
}

export function auditActorFrom(input: { uid: string; email: string | null; type: "admin" | "integration" | "system" }): AuditActor {
  return { uid: input.uid, email: input.email, type: input.type };
}
