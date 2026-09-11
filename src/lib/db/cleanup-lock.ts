import "server-only";

import { query, withTransaction, toDate, SQL_NOW } from "@/lib/db/client";

const STALE_AFTER_MS = 20 * 60 * 1000;

export async function acquireCleanupLock(): Promise<boolean> {
  return withTransaction(async (client) => {
    // The write transaction serializes access, replacing PostgreSQL's FOR UPDATE.
    const result = await client.query(`SELECT state, started_at FROM cleanup_lock WHERE id = 1`);
    const row = result.rows[0];
    const startedAt = toDate(row?.started_at);
    const active = row?.state === "running" && startedAt && Date.now() - startedAt.getTime() < STALE_AFTER_MS;
    if (active) return false;
    await client.query(`UPDATE cleanup_lock SET state = 'running', started_at = ${SQL_NOW}, completed_at = NULL, last_error = NULL WHERE id = 1`);
    return true;
  });
}

export async function releaseCleanupLock(summary: Record<string, unknown>, error?: string): Promise<void> {
  await query(`UPDATE cleanup_lock SET state = 'idle', completed_at = ${SQL_NOW}, last_summary = $1, last_error = $2 WHERE id = 1`, [JSON.stringify(summary), error ?? null]);
}

export interface CleanupStatus {
  state: string;
  startedAt: string | null;
  completedAt: string | null;
  lastSummary: Record<string, unknown> | null;
  lastError: string | null;
}

export async function getCleanupStatus(): Promise<CleanupStatus> {
  const result = await query(`SELECT state, started_at, completed_at, last_summary, last_error FROM cleanup_lock WHERE id = 1`);
  const row = result.rows[0];
  return {
    state: typeof row?.state === "string" ? row.state : "unknown",
    startedAt: toDate(row?.started_at)?.toISOString() ?? null,
    completedAt: toDate(row?.completed_at)?.toISOString() ?? null,
    lastSummary: row?.last_summary && typeof row.last_summary === "object" ? row.last_summary as Record<string, unknown> : null,
    lastError: typeof row?.last_error === "string" ? row.last_error : null,
  };
}
