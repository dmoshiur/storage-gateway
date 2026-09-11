import "server-only";

import { ApiError } from "@/lib/api/errors";
import { query, withTransaction, toDate, nullableIso } from "@/lib/db/client";
import { calculateDeleteAt, type RetentionInput } from "@/lib/retention";
import type { FileDocument, FileFilter, FileSort, FileStatus, RetentionType, SerializedFile } from "@/types/file";
import { DOCUMENT_EXTENSION_BY_MIME, getDocumentExtension } from "@/lib/validation/documents";

const SEARCH_SCAN_LIMIT = 1000;

function extensionFrom(originalName: string, mimeType: string): string {
  return getDocumentExtension(originalName) ?? DOCUMENT_EXTENSION_BY_MIME[mimeType] ?? "pdf";
}

function cleanFilename(name: string): string {
  return name.replace(/[\\/\0\r\n]/g, "_").trim().slice(0, 180) || "document";
}

function rowToFile(row: Record<string, unknown>): FileDocument {
  const originalName = String(row.original_name ?? "document");
  const mimeType = String(row.mime_type ?? "application/pdf");
  return {
    id: String(row.id),
    storagePath: String(row.storage_path ?? ""),
    uploadKey: typeof row.upload_key === "string" ? row.upload_key : null,
    originalName,
    title: String(row.title ?? ""),
    description: String(row.description ?? ""),
    category: String(row.category ?? ""),
    tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
    mimeType,
    extension: String(row.extension ?? extensionFrom(originalName, mimeType)),
    size: Number(row.size_bytes ?? 0),
    contentHash: typeof row.content_hash === "string" ? row.content_hash : null,
    createdAt: toDate(row.created_at) ?? new Date(0),
    updatedAt: toDate(row.updated_at) ?? new Date(0),
    uploadedBy: String(row.uploaded_by ?? ""),
    isFavorite: Boolean(row.is_favorite),
    autoDeleteEnabled: Boolean(row.auto_delete_enabled),
    retentionType: (row.retention_type ?? "never") as RetentionType,
    customDeleteAt: toDate(row.custom_delete_at),
    deleteAt: toDate(row.delete_at),
    status: (row.status ?? "failed") as FileStatus,
    deletedAt: toDate(row.deleted_at),
    deletedBy: typeof row.deleted_by === "string" ? row.deleted_by : null,
    permanentDeleteAt: toDate(row.permanent_delete_at),
    permanentlyDeletedAt: toDate(row.permanently_deleted_at),
    deletionStartedAt: toDate(row.deletion_started_at),
    deletionPreviousStatus: row.deletion_previous_status === "active" || row.deletion_previous_status === "trash" ? row.deletion_previous_status : null,
    deletionReason: typeof row.deletion_reason === "string" ? row.deletion_reason as FileDocument["deletionReason"] : null,
    uploadExpiresAt: toDate(row.upload_expires_at),
    validatedAt: toDate(row.validated_at),
    lastAccessedAt: toDate(row.last_accessed_at),
    lastDownloadedAt: toDate(row.last_downloaded_at),
    failureCode: typeof row.failure_code === "string" ? row.failure_code : null,
    version: Number(row.version ?? 1),
  };
}

const FILE_COLUMNS = `id, storage_path, upload_key, original_name, title, description,
 category, tags, mime_type, extension, size_bytes, content_hash, created_at, updated_at,
 uploaded_by, is_favorite, auto_delete_enabled, retention_type, custom_delete_at, delete_at,
 status, deleted_at, deleted_by, permanent_delete_at, permanently_deleted_at, deletion_started_at,
 deletion_previous_status, deletion_reason, upload_expires_at, validated_at, last_accessed_at,
 last_downloaded_at, failure_code, version`;

export function serializeFile(file: FileDocument): SerializedFile {
  return {
    id: file.id,
    originalName: file.originalName,
    title: file.title,
    description: file.description,
    category: file.category,
    tags: file.tags,
    mimeType: file.mimeType,
    extension: file.extension,
    size: file.size,
    contentHash: file.contentHash,
    createdAt: file.createdAt.toISOString(),
    updatedAt: file.updatedAt.toISOString(),
    uploadedBy: file.uploadedBy,
    isFavorite: file.isFavorite,
    autoDeleteEnabled: file.autoDeleteEnabled,
    retentionType: file.retentionType,
    customDeleteAt: nullableIso(file.customDeleteAt),
    deleteAt: nullableIso(file.deleteAt),
    status: file.status,
    deletedAt: nullableIso(file.deletedAt),
    deletedBy: file.deletedBy,
    permanentDeleteAt: nullableIso(file.permanentDeleteAt),
    permanentlyDeletedAt: nullableIso(file.permanentlyDeletedAt),
    deletionStartedAt: nullableIso(file.deletionStartedAt),
    deletionReason: file.deletionReason,
    lastAccessedAt: nullableIso(file.lastAccessedAt),
    lastDownloadedAt: nullableIso(file.lastDownloadedAt),
    failureCode: file.failureCode,
  };
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
}

type RunQuery = (text: string, values?: unknown[]) => Promise<unknown>;

async function syncTags(fileId: string, tags: string[], run: RunQuery = query as unknown as RunQuery): Promise<void> {
  const clean = normalizeTags(tags);
  if (!clean.length) return;
  for (const tag of clean) await run(`INSERT INTO tags(name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [tag]);
  await run(`DELETE FROM file_tags WHERE file_id = $1`, [fileId]);
  await run(`INSERT INTO file_tags(file_id, tag_id) SELECT $1, id FROM tags WHERE name = ANY($2::text[]) ON CONFLICT DO NOTHING`, [fileId, clean]);
}

function retentionValues(input: RetentionInput, now: Date): { autoDeleteEnabled: boolean; retentionType: RetentionType; customDeleteAt: Date | null; deleteAt: Date | null } {
  const customDeleteAt = input.customDeleteAt ? new Date(`${input.customDeleteAt}T00:00:00.000Z`) : null;
  return { autoDeleteEnabled: input.autoDeleteEnabled, retentionType: input.retentionType, customDeleteAt, deleteAt: calculateDeleteAt(input, now) };
}

export async function createUploadingFile(input: {
  storagePath: string;
  uploadKey: string | null;
  originalName: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  mimeType: string;
  extension: string;
  size: number;
  uploadedBy: string;
  contentHash?: string | null;
  retention: RetentionInput;
}): Promise<FileDocument> {
  const now = new Date();
  const retention = retentionValues(input.retention, now);
  const tags = normalizeTags(input.tags);
  return withTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO files(storage_path, upload_key, original_name, title, description, category, tags, mime_type, extension,
         size_bytes, content_hash, uploaded_by, auto_delete_enabled, retention_type, custom_delete_at, delete_at,
         status, upload_expires_at, version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'uploading',now() + interval '20 minutes',1)
       RETURNING ${FILE_COLUMNS}`,
      [input.storagePath, input.uploadKey, cleanFilename(input.originalName), input.title, input.description, input.category, tags, input.mimeType, input.extension, input.size, input.contentHash ?? null, input.uploadedBy, retention.autoDeleteEnabled, retention.retentionType, retention.customDeleteAt, retention.deleteAt],
    );
    const file = rowToFile(result.rows[0]!);
    await syncTags(file.id, file.tags, (text, values) => client.query(text, values));
    return file;
  });
}

export async function createBridgeFile(input: {
  storagePath: string;
  contentHash?: string | null;
  originalName: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  mimeType: string;
  extension: string;
  size: number;
  uploadedBy: string;
  retention: RetentionInput;
}): Promise<FileDocument> {
  const now = new Date();
  const retention = retentionValues(input.retention, now);
  const tags = normalizeTags(input.tags);
  return withTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO files(storage_path, original_name, title, description, category, tags, mime_type, extension,
         size_bytes, content_hash, uploaded_by, auto_delete_enabled, retention_type, custom_delete_at, delete_at,
         status, validated_at, version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'active',$17,1)
       RETURNING ${FILE_COLUMNS}`,
      [input.storagePath, cleanFilename(input.originalName), input.title, input.description, input.category, tags, input.mimeType, input.extension, input.size, input.contentHash ?? null, input.uploadedBy, retention.autoDeleteEnabled, retention.retentionType, retention.customDeleteAt, retention.deleteAt, now],
    );
    const file = rowToFile(result.rows[0]!);
    await syncTags(file.id, file.tags, (text, values) => client.query(text, values));
    return file;
  });
}

export async function getFileById(id: string): Promise<FileDocument | null> {
  const result = await query(`SELECT ${FILE_COLUMNS} FROM files WHERE id = $1`, [id]);
  return result.rows[0] ? rowToFile(result.rows[0]) : null;
}

export async function getUploadingFileByStoragePath(storagePath: string, userId: string): Promise<FileDocument | null> {
  const result = await query(`SELECT ${FILE_COLUMNS} FROM files WHERE storage_path = $1 AND uploaded_by = $2 AND status = 'uploading' LIMIT 1`, [storagePath, userId]);
  return result.rows[0] ? rowToFile(result.rows[0]) : null;
}

export async function requireFileById(id: string): Promise<FileDocument> {
  const file = await getFileById(id);
  if (!file) throw new ApiError(404, "FILE_NOT_FOUND", "The requested document was not found.");
  return file;
}

export async function activateUpload(id: string): Promise<FileDocument> {
  const result = await query(`UPDATE files SET status = 'active', validated_at = now(), updated_at = now(), failure_code = NULL, version = version + 1 WHERE id = $1 AND status = 'uploading' RETURNING ${FILE_COLUMNS}`, [id]);
  if (result.rows[0]) return rowToFile(result.rows[0]);
  const existing = await requireFileById(id);
  if (existing.status === "active") return existing;
  throw new ApiError(409, "UPLOAD_NOT_PENDING", "This upload is no longer awaiting completion.");
}

export async function markUploadFailed(id: string, failureCode: string): Promise<void> {
  await query(`UPDATE files SET status = 'failed', failure_code = $2, updated_at = now(), version = version + 1 WHERE id = $1`, [id, failureCode]);
}

export async function markUploadOrphaned(id: string, failureCode: string, retryWindowMs = 30 * 60 * 1000): Promise<void> {
  await query(`UPDATE files SET failure_code = $2, upload_expires_at = now() + ($3::int * interval '1 millisecond'), updated_at = now() WHERE id = $1`, [id, failureCode, retryWindowMs]);
}

export async function clearUploadKey(id: string): Promise<void> {
  await query(`UPDATE files SET upload_key = NULL, updated_at = now() WHERE id = $1`, [id]);
}

export async function updateFileDetails(id: string, patch: { title?: string; description?: string; category?: string; tags?: string[]; retention?: RetentionInput }): Promise<{ file: FileDocument; changedRetention: boolean }> {
  return withTransaction(async (client) => {
    const currentResult = await client.query(`SELECT ${FILE_COLUMNS} FROM files WHERE id = $1 FOR UPDATE`, [id]);
    if (!currentResult.rows[0]) throw new ApiError(404, "FILE_NOT_FOUND", "The requested document was not found.");
    const file = rowToFile(currentResult.rows[0]);
    if (file.status !== "active") throw new ApiError(409, "FILE_NOT_ACTIVE", "Only active documents can be edited.");
    const now = new Date();
    const retention = patch.retention ? retentionValues(patch.retention, now) : null;
    const nextTags = normalizeTags(patch.tags ?? file.tags);
    const result = await client.query(
      `UPDATE files SET title = $2, description = $3, category = $4, tags = $5,
         auto_delete_enabled = $6, retention_type = $7, custom_delete_at = $8, delete_at = $9,
         updated_at = $10, version = version + 1
       WHERE id = $1 RETURNING ${FILE_COLUMNS}`,
      [id, patch.title ?? file.title, patch.description ?? file.description, patch.category ?? file.category, nextTags,
        retention?.autoDeleteEnabled ?? file.autoDeleteEnabled, retention?.retentionType ?? file.retentionType, retention ? retention.customDeleteAt : file.customDeleteAt, retention ? retention.deleteAt : file.deleteAt, now],
    );
    const next = rowToFile(result.rows[0]!);
    for (const tag of [...new Set(next.tags.map((value) => value.trim().toLowerCase()).filter(Boolean))]) {
      await client.query(`INSERT INTO tags(name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [tag]);
    }
    await client.query(`DELETE FROM file_tags WHERE file_id = $1`, [id]);
    await client.query(`INSERT INTO file_tags(file_id, tag_id) SELECT $1, id FROM tags WHERE name = ANY($2::text[]) ON CONFLICT DO NOTHING`, [id, next.tags]);
    return { file: next, changedRetention: Boolean(patch.retention) };
  });
}

export async function moveFileToTrash(id: string, trashRetentionDays: number, reason: "manual" | "auto_retention", deletedBy: string | null = null): Promise<FileDocument> {
  const result = await query(`UPDATE files SET status = 'trash', deleted_at = now(), deleted_by = $2, permanent_delete_at = now() + ($3::int * interval '1 day'), deletion_reason = $4, updated_at = now(), version = version + 1 WHERE id = $1 AND status = 'active' RETURNING ${FILE_COLUMNS}`, [id, deletedBy, trashRetentionDays, reason]);
  if (result.rows[0]) return rowToFile(result.rows[0]);
  const existing = await requireFileById(id);
  if (existing.status === "trash") return existing;
  throw new ApiError(409, "FILE_NOT_ACTIVE", "Only active documents can be moved to Trash.");
}

export async function restoreFileFromTrash(id: string, options: { nextDeleteAt: Date | null; resetElapsedCustomRetention?: boolean }): Promise<FileDocument> {
  const result = await query(
    `UPDATE files SET status = 'active', deleted_at = NULL, deleted_by = NULL, permanent_delete_at = NULL, deletion_reason = NULL,
       delete_at = $2, auto_delete_enabled = CASE WHEN $3 THEN false ELSE auto_delete_enabled END,
       retention_type = CASE WHEN $3 THEN 'never' ELSE retention_type END,
       custom_delete_at = CASE WHEN $3 THEN NULL ELSE custom_delete_at END,
       updated_at = now(), version = version + 1
     WHERE id = $1 AND status = 'trash' RETURNING ${FILE_COLUMNS}`,
    [id, options.nextDeleteAt, Boolean(options.resetElapsedCustomRetention)],
  );
  if (result.rows[0]) return rowToFile(result.rows[0]);
  const existing = await requireFileById(id);
  if (existing.status === "active") return existing;
  throw new ApiError(409, "FILE_NOT_IN_TRASH", "Only documents in Trash can be restored.");
}

async function beginDeletion(id: string, expectedStatus: "trash" | "active"): Promise<FileDocument> {
  const result = await query(`UPDATE files SET status = 'deleting', deletion_started_at = now(), deletion_previous_status = $2, updated_at = now(), version = version + 1 WHERE id = $1 AND status = $2 RETURNING ${FILE_COLUMNS}`, [id, expectedStatus]);
  if (result.rows[0]) return rowToFile(result.rows[0]);
  const existing = await requireFileById(id);
  if (existing.status === "deleting" || existing.status === "deleted") return existing;
  throw new ApiError(409, expectedStatus === "trash" ? "FILE_NOT_IN_TRASH" : "FILE_NOT_ACTIVE", "The document is not in a deletable state.");
}

export async function beginPermanentDeletion(id: string): Promise<FileDocument> { return beginDeletion(id, "trash"); }
export async function beginActivePermanentDeletion(id: string): Promise<FileDocument> { return beginDeletion(id, "active"); }

export async function completePermanentDeletion(id: string): Promise<FileDocument> {
  const result = await query(`UPDATE files SET status = 'deleted', permanently_deleted_at = now(), permanent_delete_at = NULL, deletion_started_at = NULL, deletion_previous_status = NULL, updated_at = now(), version = version + 1 WHERE id = $1 AND status = 'deleting' RETURNING ${FILE_COLUMNS}`, [id]);
  if (result.rows[0]) return rowToFile(result.rows[0]);
  const existing = await requireFileById(id);
  if (existing.status === "deleted") return existing;
  throw new ApiError(409, "DELETE_NOT_PENDING", "This document is not awaiting permanent deletion.");
}

async function revertDeletion(id: string, failureCode: string, fallbackStatus: "active" | "trash"): Promise<void> {
  await query(`UPDATE files SET status = COALESCE(deletion_previous_status, $2), deletion_started_at = NULL, deletion_previous_status = NULL, failure_code = $3, updated_at = now() WHERE id = $1 AND status = 'deleting'`, [id, fallbackStatus, failureCode]);
}
export async function revertActivePermanentDeletion(id: string, failureCode: string): Promise<void> { return revertDeletion(id, failureCode, "active"); }
export async function revertPermanentDeletion(id: string, failureCode: string): Promise<void> { return revertDeletion(id, failureCode, "trash"); }

export async function markActivePermanentlyDeleted(id: string): Promise<FileDocument> {
  const result = await query(`UPDATE files SET status = 'deleted', permanently_deleted_at = now(), permanent_delete_at = NULL, deletion_started_at = NULL, deletion_previous_status = NULL, updated_at = now(), version = version + 1 WHERE id = $1 AND status IN ('active','deleting') RETURNING ${FILE_COLUMNS}`, [id]);
  if (result.rows[0]) return rowToFile(result.rows[0]);
  return requireFileById(id);
}

export async function markDeletedAfterFailedUpload(id: string): Promise<void> {
  await query(`UPDATE files SET status = 'deleted', permanently_deleted_at = now(), deletion_started_at = NULL, deletion_previous_status = NULL, updated_at = now(), version = version + 1 WHERE id = $1`, [id]);
}

function sortDefinition(sort: FileSort, status: "all" | FileStatus): { field: keyof FileDocument; direction: "asc" | "desc" } {
  switch (sort) {
    case "oldest": return { field: "createdAt", direction: "asc" };
    case "largest": return { field: "size", direction: "desc" };
    case "smallest": return { field: "size", direction: "asc" };
    case "delete_date": return { field: status === "trash" ? "permanentDeleteAt" : "deleteAt", direction: "asc" };
    case "name": return { field: "originalName", direction: "asc" };
    default: return { field: "createdAt", direction: "desc" };
  }
}
function statusFor(input: { status: "all" | FileStatus; filter: FileFilter }): "all" | FileStatus {
  if (input.filter === "trash") return "trash";
  if (["active", "auto_delete", "never_delete", "expiring_soon", "expired", "favorites", "recent"].includes(input.filter)) return "active";
  return input.status;
}
function matchesText(file: FileDocument, search: string): boolean {
  if (!search) return true;
  const needle = search.toLowerCase();
  return [file.id, file.originalName, file.title, file.description, file.category, file.uploadedBy, ...file.tags].some((value) => value.toLowerCase().includes(needle));
}
function matchesDerived(file: FileDocument, filter: FileFilter, now: Date, onlyAccessible = false): boolean {
  if (onlyAccessible && file.autoDeleteEnabled && file.deleteAt && file.deleteAt <= now) return false;
  if (filter === "auto_delete") return file.autoDeleteEnabled;
  if (filter === "never_delete") return !file.autoDeleteEnabled || file.retentionType === "never";
  if (filter === "expiring_soon") return Boolean(file.autoDeleteEnabled && file.deleteAt && file.deleteAt > now && file.deleteAt <= new Date(now.getTime() + 30 * 86400000));
  if (filter === "expired") return Boolean(file.autoDeleteEnabled && file.deleteAt && file.deleteAt <= now);
  if (filter === "favorites") return file.isFavorite;
  if (filter === "recent") return file.createdAt.getTime() >= now.getTime() - 30 * 86400000;
  return true;
}
function matchesRetention(file: FileDocument, retention?: RetentionType | ""): boolean {
  if (!retention) return true;
  return retention === "never" ? !file.autoDeleteEnabled || file.retentionType === "never" : file.autoDeleteEnabled && file.retentionType === retention;
}
function compareFiles(left: FileDocument, right: FileDocument, field: keyof FileDocument, direction: "asc" | "desc"): number {
  const a = left[field]; const b = right[field];
  const av = a instanceof Date ? a.getTime() : typeof a === "number" ? a : String(a ?? "");
  const bv = b instanceof Date ? b.getTime() : typeof b === "number" ? b : String(b ?? "");
  const comparison = typeof av === "string" || typeof bv === "string" ? String(av).localeCompare(String(bv)) : Number(av) - Number(bv);
  return (comparison || left.id.localeCompare(right.id)) * (direction === "asc" ? 1 : -1);
}
function encodeCursor(id: string): string { return Buffer.from(id).toString("base64url"); }
function decodeCursor(cursor?: string): string | undefined {
  if (!cursor) return undefined;
  try { const id = Buffer.from(cursor, "base64url").toString("utf8"); return /^[0-9a-f-]{20,80}$/i.test(id) ? id : undefined; } catch { return undefined; }
}

export interface ListFilesInput { pageSize: number; cursor?: string; status: "all" | FileStatus; filter: FileFilter; sort: FileSort; search: string; category?: string; retention?: RetentionType | ""; onlyAccessible?: boolean }
export interface ListFilesPagination { count: number; pageSize: number; nextCursor: string | null; hasMore: boolean }
export interface ListFilesResult { files: SerializedFile[]; nextCursor: string | null; searchLimited: boolean; pagination: ListFilesPagination }

export async function listFiles(input: ListFilesInput): Promise<ListFilesResult> {
  const resolvedStatus = statusFor(input);
  const result = await query(`SELECT ${FILE_COLUMNS} FROM files WHERE ($1 = 'all' OR status = $1) ORDER BY created_at DESC LIMIT $2`, [resolvedStatus, SEARCH_SCAN_LIMIT]);
  const now = new Date();
  const order = sortDefinition(input.sort, resolvedStatus);
  const cursorId = decodeCursor(input.cursor);
  const all = result.rows.map(rowToFile)
    .filter((file) => matchesText(file, input.search))
    .filter((file) => !input.category || file.category.toLowerCase() === input.category.toLowerCase())
    .filter((file) => matchesRetention(file, input.retention))
    .filter((file) => matchesDerived(file, input.filter, now, input.onlyAccessible))
    .sort((a, b) => compareFiles(a, b, order.field, order.direction));
  const start = cursorId ? Math.max(0, all.findIndex((file) => file.id === cursorId) + 1) : 0;
  const page = all.slice(start, start + input.pageSize);
  const nextCursor = start + input.pageSize < all.length && page.length ? encodeCursor(page.at(-1)!.id) : null;
  return { files: page.map(serializeFile), nextCursor, searchLimited: result.rows.length === SEARCH_SCAN_LIMIT, pagination: { count: page.length, pageSize: input.pageSize, nextCursor, hasMore: Boolean(nextCursor) } };
}

async function selectFiles(where: string, values: unknown[], limit = 500): Promise<FileDocument[]> {
  const result = await query(`SELECT ${FILE_COLUMNS} FROM files WHERE ${where} LIMIT $${values.length + 1}`, [...values, limit]);
  return result.rows.map(rowToFile);
}
export async function getRecentFiles(status: FileStatus, limit = 6): Promise<FileDocument[]> { return selectFiles(`status = $1 ORDER BY created_at DESC`, [status], limit); }
export async function getExpiredActiveFiles(now: Date, limit = 500): Promise<FileDocument[]> { return selectFiles(`status = 'active' AND auto_delete_enabled = true AND delete_at <= $1 ORDER BY delete_at ASC`, [now], limit); }
export async function getExpiredTrashFiles(now: Date, limit = 500): Promise<FileDocument[]> { return selectFiles(`status = 'trash' AND permanent_delete_at <= $1 ORDER BY permanent_delete_at ASC`, [now], limit); }
export async function getStaleUploads(before: Date, limit = 100): Promise<FileDocument[]> { return selectFiles(`status = 'uploading' AND upload_expires_at <= $1 ORDER BY upload_expires_at ASC`, [before], limit); }
export async function getFailedUploadFiles(limit = 100): Promise<FileDocument[]> { return selectFiles(`status = 'failed'`, [], limit); }
export async function getPendingPermanentDeletes(limit = 200): Promise<FileDocument[]> { return selectFiles(`status = 'deleting'`, [], limit); }
export async function getUploadingFilesForReservation(limit = 1000): Promise<FileDocument[]> { return selectFiles(`status = 'uploading'`, [], limit); }
export async function getActiveStagingFiles(limit = 100): Promise<FileDocument[]> { return selectFiles(`status = 'active' AND upload_key IS NOT NULL`, [], limit); }
export async function listFilesForStats(): Promise<FileDocument[]> { return selectFiles(`status IN ('active','trash')`, [], 100000); }

export async function applyDefaultRetentionToActiveFiles(input: { autoDeleteEnabled: boolean; retentionType: Exclude<RetentionType, "custom_date"> }): Promise<number> {
  const now = new Date();
  const deleteAt = calculateDeleteAt({ ...input, customDeleteAt: null }, now);
  const result = await query(`UPDATE files SET auto_delete_enabled = $1, retention_type = $2, custom_delete_at = NULL, delete_at = $3, updated_at = now(), version = version + 1 WHERE status = 'active'`, [input.autoDeleteEnabled, input.retentionType, deleteAt]);
  return result.rowCount ?? 0;
}

export async function attachBlobIdentity(id: string, identity: { size?: number; contentHash?: string | null }): Promise<void> {
  await query(`UPDATE files SET size_bytes = COALESCE($2, size_bytes), content_hash = CASE WHEN $3::text IS NULL THEN content_hash ELSE $3 END, updated_at = now() WHERE id = $1`, [id, identity.size ?? null, identity.contentHash ?? null]);
}
export async function setFileFavorite(id: string, isFavorite: boolean): Promise<FileDocument> { const result = await query(`UPDATE files SET is_favorite = $2, updated_at = now(), version = version + 1 WHERE id = $1 RETURNING ${FILE_COLUMNS}`, [id, isFavorite]); if (!result.rows[0]) throw new ApiError(404, "FILE_NOT_FOUND", "The requested document was not found."); return rowToFile(result.rows[0]); }
export async function recordFileAccess(id: string, kind: "preview" | "download"): Promise<void> { try { await query(`UPDATE files SET last_accessed_at = now(), last_downloaded_at = CASE WHEN $2 = 'download' THEN now() ELSE last_downloaded_at END WHERE id = $1`, [id, kind]); } catch { /* analytics never break access */ } }
export async function findActiveFileByContentHash(contentHash: string): Promise<FileDocument | null> { const result = await query(`SELECT ${FILE_COLUMNS} FROM files WHERE status = 'active' AND content_hash = $1 LIMIT 1`, [contentHash]); return result.rows[0] ? rowToFile(result.rows[0]) : null; }
export async function getFilesExpiringBetween(from: Date, to: Date, limit = 200): Promise<FileDocument[]> { return selectFiles(`status = 'active' AND auto_delete_enabled = true AND delete_at >= $1 AND delete_at <= $2 ORDER BY delete_at ASC`, [from, to], limit); }
export async function getFavoriteFiles(limit = 200): Promise<FileDocument[]> { return selectFiles(`status = 'active' AND is_favorite = true ORDER BY updated_at DESC`, [], limit); }
