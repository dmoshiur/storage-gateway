import "server-only";

import { query, toDate } from "@/lib/db/client";
import type { AuditAction, AuditActor, AuditLogDocument, SerializedAuditLog } from "@/types/audit";
import { logger } from "@/lib/logging/logger";

export async function writeAuditLog(input: Omit<AuditLogDocument, "createdAt"> & { requestId?: string | null }): Promise<void> {
  await query(
    `INSERT INTO audit_logs(action, actor_id, actor_email, actor_type, file_id, file_name, details, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.action,
      input.actor.uid,
      input.actor.email,
      input.actor.type,
      input.fileId ?? null,
      input.fileName ?? null,
      JSON.stringify(input.details ?? {}),
      input.requestId ?? null,
    ],
  );
}

export async function writeAuditLogSafely(input: Omit<AuditLogDocument, "createdAt"> & { requestId?: string | null }): Promise<void> {
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

function serialize(row: Record<string, unknown>): SerializedAuditLog {
  return {
    id: String(row.id),
    action: row.action as AuditAction,
    actor: { uid: String(row.actor_id), email: typeof row.actor_email === "string" ? row.actor_email : null, type: row.actor_type as AuditActor["type"] },
    ...(typeof row.file_id === "string" ? { fileId: row.file_id } : {}),
    ...(typeof row.file_name === "string" ? { fileName: row.file_name } : {}),
    ...(row.details && typeof row.details === "object" ? { details: row.details as Record<string, string | number | boolean | null> } : {}),
    createdAt: toDate(row.created_at)?.toISOString() ?? new Date(0).toISOString(),
  };
}

export async function listAuditLogs(pageSize = 50, cursor?: string): Promise<{ logs: SerializedAuditLog[]; nextCursor: string | null }> {
  const values: unknown[] = [Math.min(Math.max(Math.trunc(pageSize), 1), 200) + 1];
  const cursorClause = cursor ? `AND created_at < (SELECT created_at FROM audit_logs WHERE id = $2)` : "";
  if (cursor) values.push(cursor);
  const result = await query(
    `SELECT id, action, actor_id, actor_email, actor_type, file_id, file_name, details, created_at
     FROM audit_logs WHERE true ${cursorClause} ORDER BY created_at DESC, id DESC LIMIT $1`,
    values,
  );
  const visible = result.rows.slice(0, values[0] as number - 1);
  return { logs: visible.map(serialize), nextCursor: result.rows.length > visible.length ? String(visible.at(-1)?.id ?? "") || null : null };
}

export function auditActorFrom(input: { uid: string; email: string | null; type: "admin" | "integration" | "system" }): AuditActor {
  return { uid: input.uid, email: input.email, type: input.type };
}
