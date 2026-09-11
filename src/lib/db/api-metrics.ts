import "server-only";

import { query, toDate } from "@/lib/db/client";

const MAX_UPLOAD_LOGS = 50;

export interface ApiRequestContext {
  method?: string;
  path?: string;
  statusCode?: number;
  requestId?: string;
  ip?: string | null;
}

export interface UploadLogEntry {
  keyId: string;
  filename: string;
  sizeBytes: number;
  status: "success" | "failed";
  failureCode: string | null;
  requestId: string;
  timestamp: string;
}

export interface RecentUploadLog extends UploadLogEntry {
  id: string;
}

export async function recordApiRequest(keyId: string, input: ApiRequestContext = {}): Promise<void> {
  await query(
    `INSERT INTO api_request_logs(key_id, method, path, status_code, request_id, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [keyId, input.method ?? "GET", input.path ?? "/api/v1", input.statusCode ?? null, input.requestId ?? "unknown", input.ip ?? null],
  );
}

export async function recordApiRequestSafe(keyId: string, input: Parameters<typeof recordApiRequest>[1] = {}): Promise<void> {
  try { await recordApiRequest(keyId, input); } catch { /* metrics must not fail requests */ }
}

export interface ApiRequestTotals {
  totalRequests: number;
  lastRequestDate: string | null;
}

export async function getApiRequestTotals(lookbackDays = 366): Promise<ApiRequestTotals> {
  const result = await query<{ total: string; last_request: Date | null }>(
    `SELECT count(*)::text AS total, max(created_at) AS last_request
     FROM api_request_logs WHERE created_at >= now() - ($1::int * interval '1 day')`,
    [lookbackDays],
  );
  return { totalRequests: Number(result.rows[0]?.total ?? 0), lastRequestDate: toDate(result.rows[0]?.last_request)?.toISOString() ?? null };
}

export async function recordUploadLog(entry: UploadLogEntry): Promise<void> {
  await query(
    `INSERT INTO api_upload_logs(key_id, filename, size_bytes, status, failure_code, request_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [entry.keyId, entry.filename, entry.sizeBytes, entry.status, entry.failureCode, entry.requestId, new Date(entry.timestamp)],
  );
  await query(`DELETE FROM api_upload_logs WHERE id IN (SELECT id FROM api_upload_logs ORDER BY created_at DESC OFFSET $1)`, [MAX_UPLOAD_LOGS]);
}

export async function getRecentUploadLogs(limit = 5): Promise<RecentUploadLog[]> {
  const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
  const result = await query(`SELECT id, key_id, filename, size_bytes, status, failure_code, request_id, created_at FROM api_upload_logs ORDER BY created_at DESC LIMIT $1`, [safeLimit]);
  return result.rows.map((row) => ({
    id: String(row.id),
    keyId: String(row.key_id ?? ""),
    filename: String(row.filename ?? "unknown"),
    sizeBytes: Number(row.size_bytes ?? 0),
    status: row.status === "failed" ? "failed" : "success",
    failureCode: typeof row.failure_code === "string" ? row.failure_code : null,
    requestId: String(row.request_id ?? ""),
    timestamp: toDate(row.created_at)?.toISOString() ?? "",
  }));
}
