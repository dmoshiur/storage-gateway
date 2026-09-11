import "server-only";

import type { DocumentSnapshot, Firestore, Query } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { ApiError } from "@/lib/api/errors";
import { describeFailure, indexBuildLink, isMissingIndexError } from "@/lib/api/failures";
import { logger } from "@/lib/logging/logger";
import { calculateDeleteAt, type RetentionInput } from "@/lib/retention";
import type { FileDocument, FileFilter, FileSort, FileStatus, RetentionType, SerializedFile } from "@/types/file";
import { DOCUMENT_EXTENSION_BY_MIME, getDocumentExtension } from "@/lib/validation/documents";
import { asDate, toIso } from "@/utils/date";

/**
 * The single real metadata collection. Every document here describes one PDF
 * whose bytes live in the private Blob store under `storagePath`. Reserved /
 * probe document ids (for example `__gateway_probe__`) are never written to
 * Firestore — connectivity probes read existing documents instead.
 */
const FILES = "files";
/** Upper bound for the server-side search/filter scan window. */
const SEARCH_SCAN_LIMIT = 1000;

function extensionFrom(originalName: string, mimeType: string): string {
  return getDocumentExtension(originalName) ?? DOCUMENT_EXTENSION_BY_MIME[mimeType] ?? "pdf";
}

function toDocument(snapshot: DocumentSnapshot): FileDocument {
  const data = snapshot.data();
  if (!data) throw new ApiError(404, "FILE_NOT_FOUND", "The requested document was not found.");
  const originalName = String(data.originalName);
  const mimeType = String(data.mimeType ?? "application/pdf");
  return {
    id: snapshot.id,
    storagePath: String(data.storagePath ?? data.storageKey ?? ""),
    blobUrl: typeof data.blobUrl === "string" ? data.blobUrl : null,
    uploadKey: typeof data.uploadKey === "string" ? data.uploadKey : null,
    originalName,
    title: String(data.title ?? ""),
    description: String(data.description ?? ""),
    category: String(data.category ?? ""),
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    mimeType,
    extension: String(data.extension ?? extensionFrom(originalName, mimeType)),
    size: Number(data.size),
    contentHash: typeof data.contentHash === "string" ? data.contentHash : null,
    createdAt: asDate(data.createdAt) ?? new Date(0),
    updatedAt: asDate(data.updatedAt) ?? new Date(0),
    uploadedBy: String(data.uploadedBy),
    isFavorite: Boolean(data.isFavorite),
    autoDeleteEnabled: Boolean(data.autoDeleteEnabled),
    retentionType: data.retentionType as RetentionType,
    customDeleteAt: asDate(data.customDeleteAt),
    deleteAt: asDate(data.deleteAt),
    status: data.status as FileStatus,
    deletedAt: asDate(data.deletedAt),
    deletedBy: typeof data.deletedBy === "string" ? data.deletedBy : null,
    permanentDeleteAt: asDate(data.permanentDeleteAt),
    permanentlyDeletedAt: asDate(data.permanentlyDeletedAt),
    deletionStartedAt: asDate(data.deletionStartedAt),
    deletionPreviousStatus: data.deletionPreviousStatus === "active" || data.deletionPreviousStatus === "trash" ? data.deletionPreviousStatus : null,
    deletionReason: data.deletionReason ?? null,
    uploadExpiresAt: asDate(data.uploadExpiresAt),
    validatedAt: asDate(data.validatedAt),
    lastAccessedAt: asDate(data.lastAccessedAt),
    lastDownloadedAt: asDate(data.lastDownloadedAt),
    failureCode: data.failureCode ?? null,
    version: Number(data.version ?? 1),
  };
}

export function serializeFile(file: FileDocument): SerializedFile {
  // storagePath, blobUrl, and upload lifecycle fields are intentionally never returned to browsers/integrations.
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
    customDeleteAt: toIso(file.customDeleteAt),
    deleteAt: toIso(file.deleteAt),
    status: file.status,
    deletedAt: toIso(file.deletedAt),
    deletedBy: file.deletedBy,
    permanentDeleteAt: toIso(file.permanentDeleteAt),
    permanentlyDeletedAt: toIso(file.permanentlyDeletedAt),
    deletionStartedAt: toIso(file.deletionStartedAt),
    deletionReason: file.deletionReason,
    lastAccessedAt: toIso(file.lastAccessedAt),
    lastDownloadedAt: toIso(file.lastDownloadedAt),
    failureCode: file.failureCode,
  };
}

function cleanFilename(name: string): string {
  return name.replace(/[\\/\0\r\n]/g, "_").trim().slice(0, 180) || "document";
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
  const db = getAdminDb();
  const reference = db.collection(FILES).doc();
  const now = new Date();
  const retention = {
    autoDeleteEnabled: input.retention.autoDeleteEnabled,
    retentionType: input.retention.retentionType,
    customDeleteAt: input.retention.customDeleteAt ? new Date(`${input.retention.customDeleteAt}T00:00:00.000Z`) : null,
    deleteAt: calculateDeleteAt(input.retention, now),
  };
  const document: FileDocument = {
    id: reference.id,
    storagePath: input.storagePath,
    blobUrl: null,
    uploadKey: input.uploadKey,
    originalName: cleanFilename(input.originalName),
    title: input.title,
    description: input.description,
    category: input.category,
    tags: [...new Set(input.tags.map((tag) => tag.toLowerCase()))],
    mimeType: input.mimeType,
    extension: input.extension,
    size: input.size,
    contentHash: input.contentHash ?? null,
    createdAt: now,
    updatedAt: now,
    uploadedBy: input.uploadedBy,
    isFavorite: false,
    ...retention,
    status: "uploading",
    deletedAt: null,
    deletedBy: null,
    permanentDeleteAt: null,
    permanentlyDeletedAt: null,
    deletionStartedAt: null,
    deletionPreviousStatus: null,
    deletionReason: null,
    uploadExpiresAt: new Date(now.getTime() + 20 * 60 * 1000),
    validatedAt: null,
    lastAccessedAt: null,
    lastDownloadedAt: null,
    failureCode: null,
    version: 1,
  };
  await reference.create(document);
  return document;
}

export async function getFileById(id: string): Promise<FileDocument | null> {
  const snapshot = await getAdminDb().collection(FILES).doc(id).get();
  return snapshot.exists ? toDocument(snapshot) : null;
}

/**
 * Registers a document that the Storage bridge already streamed into the private
 * Blob store after its own server-side validation. The record is created directly in the
 * `active` state (validatedAt is set) so bridge uploads appear in the dashboard,
 * Trash, retention, and NGO website listings like any other managed document.
 */
export async function createBridgeFile(input: {
  storagePath: string;
  blobUrl?: string | null;
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
  const db = getAdminDb();
  const reference = db.collection(FILES).doc();
  const now = new Date();
  const document: FileDocument = {
    id: reference.id,
    storagePath: input.storagePath,
    blobUrl: input.blobUrl ?? null,
    uploadKey: null,
    originalName: cleanFilename(input.originalName),
    title: input.title,
    description: input.description,
    category: input.category,
    tags: [...new Set(input.tags.map((tag) => tag.toLowerCase()))],
    mimeType: input.mimeType,
    extension: input.extension,
    size: input.size,
    contentHash: input.contentHash ?? null,
    createdAt: now,
    updatedAt: now,
    uploadedBy: input.uploadedBy,
    isFavorite: false,
    autoDeleteEnabled: input.retention.autoDeleteEnabled,
    retentionType: input.retention.retentionType,
    customDeleteAt: input.retention.customDeleteAt ? new Date(`${input.retention.customDeleteAt}T00:00:00.000Z`) : null,
    deleteAt: calculateDeleteAt(input.retention, now),
    status: "active",
    deletedAt: null,
    deletedBy: null,
    permanentDeleteAt: null,
    permanentlyDeletedAt: null,
    deletionStartedAt: null,
    deletionPreviousStatus: null,
    deletionReason: null,
    uploadExpiresAt: null,
    validatedAt: now,
    lastAccessedAt: null,
    lastDownloadedAt: null,
    failureCode: null,
    version: 1,
  };
  await reference.create(document);
  return document;
}

export async function requireFileById(id: string): Promise<FileDocument> {
  const file = await getFileById(id);
  if (!file) throw new ApiError(404, "FILE_NOT_FOUND", "The requested document was not found.");
  return file;
}

export async function activateUpload(id: string): Promise<FileDocument> {
  const db = getAdminDb();
  const reference = db.collection(FILES).doc(id);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const file = toDocument(snapshot);
    if (file.status === "active") return file; // safe retry after a completed request.
    if (file.status !== "uploading") throw new ApiError(409, "UPLOAD_NOT_PENDING", "This upload is no longer awaiting completion.");
    const now = new Date();
    transaction.update(reference, { status: "active", validatedAt: now, updatedAt: now, failureCode: null, version: file.version + 1 });
    return { ...file, status: "active", validatedAt: now, updatedAt: now, failureCode: null, version: file.version + 1 };
  });
}

export async function markUploadFailed(id: string, failureCode: string): Promise<void> {
  await getAdminDb().collection(FILES).doc(id).set({
    status: "failed",
    failureCode,
    updatedAt: new Date(),
  }, { merge: true });
}

/**
 * Marks an upload whose bytes are already in Blob but whose Firestore
 * metadata could not be finalized — an ORPHAN.
 *
 * The record intentionally stays in `uploading` so the client can retry
 * `POST /api/files/:id/complete` and finish the metadata write without
 * re-uploading the bytes. `uploadExpiresAt` is pushed out so the scheduled
 * cleanup does not delete a retryable orphan during its retry window; once
 * that window passes, cleanup removes both the Blob object and the record.
 * Best-effort: when Firestore itself is down the caller still reports the
 * failure, and the stale-upload sweep cleans the orphan up later.
 */
export async function markUploadOrphaned(
  id: string,
  failureCode: string,
  retryWindowMs = 30 * 60 * 1000,
): Promise<void> {
  const now = new Date();
  try {
    await getAdminDb().collection(FILES).doc(id).set({
      failureCode,
      orphanedAt: now,
      uploadExpiresAt: new Date(now.getTime() + retryWindowMs),
      updatedAt: now,
    }, { merge: true });
  } catch (error) {
    logger.error("Could not mark upload as orphaned", {
      fileId: id,
      failureCode,
      cause: error instanceof Error ? error.message : "unknown",
    });
  }
}

export async function clearUploadKey(id: string): Promise<void> {
  await getAdminDb().collection(FILES).doc(id).set({ uploadKey: null, updatedAt: new Date() }, { merge: true });
}

export async function updateFileDetails(id: string, patch: {
  title?: string;
  description?: string;
  category?: string;
  tags?: string[];
  retention?: RetentionInput;
}): Promise<{ file: FileDocument; changedRetention: boolean }> {
  const db = getAdminDb();
  const reference = db.collection(FILES).doc(id);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const file = toDocument(snapshot);
    if (file.status !== "active") throw new ApiError(409, "FILE_NOT_ACTIVE", "Only active documents can be edited.");
    const now = new Date();
    const changes: Record<string, unknown> = { updatedAt: now, version: file.version + 1 };
    if (patch.title !== undefined) changes.title = patch.title;
    if (patch.description !== undefined) changes.description = patch.description;
    if (patch.category !== undefined) changes.category = patch.category;
    if (patch.tags !== undefined) changes.tags = [...new Set(patch.tags.map((tag) => tag.toLowerCase()))];
    if (patch.retention) {
      changes.autoDeleteEnabled = patch.retention.autoDeleteEnabled;
      changes.retentionType = patch.retention.retentionType;
      changes.customDeleteAt = patch.retention.customDeleteAt ? new Date(`${patch.retention.customDeleteAt}T00:00:00.000Z`) : null;
      changes.deleteAt = calculateDeleteAt(patch.retention, now);
    }
    transaction.update(reference, changes);
    const merged = {
      ...file,
      ...changes,
      customDeleteAt: changes.customDeleteAt === undefined ? file.customDeleteAt : changes.customDeleteAt as Date | null,
      deleteAt: changes.deleteAt === undefined ? file.deleteAt : changes.deleteAt as Date | null,
      updatedAt: now,
      version: file.version + 1,
    } as FileDocument;
    return { file: merged, changedRetention: Boolean(patch.retention) };
  });
}

export async function moveFileToTrash(
  id: string,
  trashRetentionDays: number,
  reason: "manual" | "auto_retention",
  deletedBy: string | null = null,
): Promise<FileDocument> {
  const db = getAdminDb();
  const reference = db.collection(FILES).doc(id);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const file = toDocument(snapshot);
    if (file.status === "trash") return file; // idempotent user retry
    if (file.status !== "active") throw new ApiError(409, "FILE_NOT_ACTIVE", "Only active documents can be moved to Trash.");
    const now = new Date();
    const permanentDeleteAt = new Date(now.getTime() + trashRetentionDays * 24 * 60 * 60 * 1000);
    const updates = { status: "trash" as const, deletedAt: now, deletedBy, permanentDeleteAt, deletionReason: reason, updatedAt: now, version: file.version + 1 };
    transaction.update(reference, updates);
    return { ...file, ...updates };
  });
}

export async function restoreFileFromTrash(id: string, options: { nextDeleteAt: Date | null; resetElapsedCustomRetention?: boolean }): Promise<FileDocument> {
  const db = getAdminDb();
  const reference = db.collection(FILES).doc(id);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const file = toDocument(snapshot);
    if (file.status === "active") return file;
    if (file.status !== "trash") throw new ApiError(409, "FILE_NOT_IN_TRASH", "Only documents in Trash can be restored.");
    const now = new Date();
    const updates = {
      status: "active" as const,
      deletedAt: null,
      deletedBy: null,
      permanentDeleteAt: null,
      deletionReason: null,
      deleteAt: options.nextDeleteAt,
      ...(options.resetElapsedCustomRetention ? { autoDeleteEnabled: false, retentionType: "never" as const, customDeleteAt: null } : {}),
      updatedAt: now,
      version: file.version + 1,
    };
    transaction.update(reference, updates);
    return { ...file, ...updates };
  });
}

export async function beginPermanentDeletion(id: string): Promise<FileDocument> {
  const db = getAdminDb();
  const reference = db.collection(FILES).doc(id);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const file = toDocument(snapshot);
    if (file.status === "deleted") return file;
    if (file.status === "deleting") return file; // a retry may safely continue the Blob delete.
    if (file.status !== "trash") throw new ApiError(409, "FILE_NOT_IN_TRASH", "Move the document to Trash before permanently deleting it.");
    const now = new Date();
    const updates = {
      status: "deleting" as const,
      deletionStartedAt: now,
      deletionPreviousStatus: "trash" as const,
      updatedAt: now,
      version: file.version + 1,
    };
    transaction.update(reference, updates);
    return { ...file, ...updates };
  });
}

export async function beginActivePermanentDeletion(id: string): Promise<FileDocument> {
  const db = getAdminDb();
  const reference = db.collection(FILES).doc(id);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const file = toDocument(snapshot);
    if (file.status === "deleted" || file.status === "deleting") return file;
    if (file.status !== "active") throw new ApiError(409, "FILE_NOT_ACTIVE", "This document cannot be permanently deleted in its current state.");
    const now = new Date();
    const updates = { status: "deleting" as const, deletionStartedAt: now, deletionPreviousStatus: "active" as const, updatedAt: now, version: file.version + 1 };
    transaction.update(reference, updates);
    return { ...file, ...updates };
  });
}

export async function completePermanentDeletion(id: string): Promise<FileDocument> {
  const db = getAdminDb();
  const reference = db.collection(FILES).doc(id);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const file = toDocument(snapshot);
    if (file.status === "deleted") return file;
    if (file.status !== "deleting") throw new ApiError(409, "DELETE_NOT_PENDING", "This document is not awaiting permanent deletion.");
    const now = new Date();
    const updates = {
      status: "deleted" as const,
      permanentlyDeletedAt: now,
      permanentDeleteAt: null,
      deletionStartedAt: null,
      deletionPreviousStatus: null,
      updatedAt: now,
      version: file.version + 1,
    };
    transaction.update(reference, updates);
    return { ...file, ...updates };
  });
}

export async function revertActivePermanentDeletion(id: string, failureCode: string): Promise<void> {
  const reference = getAdminDb().collection(FILES).doc(id);
  await getAdminDb().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists || snapshot.data()?.status !== "deleting") return;
    transaction.update(reference, { status: "active", deletionStartedAt: null, deletionPreviousStatus: null, failureCode, updatedAt: new Date() });
  });
}

export async function revertPermanentDeletion(id: string, failureCode: string): Promise<void> {
  const reference = getAdminDb().collection(FILES).doc(id);
  await getAdminDb().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists || snapshot.data()?.status !== "deleting") return;
    const previous = snapshot.data()?.deletionPreviousStatus === "active" ? "active" : "trash";
    transaction.update(reference, { status: previous, deletionStartedAt: null, deletionPreviousStatus: null, failureCode, updatedAt: new Date() });
  });
}

/** Used only when trash safety has explicitly been disabled by an administrator. */
export async function markActivePermanentlyDeleted(id: string): Promise<FileDocument> {
  const db = getAdminDb();
  const reference = db.collection(FILES).doc(id);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const file = toDocument(snapshot);
    if (file.status === "deleted") return file;
    if (file.status !== "active" && file.status !== "deleting") throw new ApiError(409, "FILE_NOT_ACTIVE", "This document cannot be permanently deleted in its current state.");
    const now = new Date();
    const updates = { status: "deleted" as const, permanentlyDeletedAt: now, permanentDeleteAt: null, deletionStartedAt: null, deletionPreviousStatus: null, updatedAt: now, version: file.version + 1 };
    transaction.update(reference, updates);
    return { ...file, ...updates };
  });
}

export async function markDeletedAfterFailedUpload(id: string): Promise<void> {
  await getAdminDb().collection(FILES).doc(id).set({ status: "deleted", permanentlyDeletedAt: new Date(), deletionStartedAt: null, deletionPreviousStatus: null, updatedAt: new Date() }, { merge: true });
}

function sortDefinition(sort: FileSort, status: "all" | FileStatus): { field: string; direction: "asc" | "desc" } {
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
  return [file.id, file.originalName, file.title, file.description, file.category, file.uploadedBy, ...file.tags]
    .some((value) => value.toLowerCase().includes(needle));
}

function matchesCategory(file: FileDocument, category?: string): boolean {
  if (!category) return true;
  return file.category.trim().toLocaleLowerCase() === category.trim().toLocaleLowerCase();
}

function matchesRetention(file: FileDocument, retention?: RetentionType | ""): boolean {
  if (!retention) return true;
  if (retention === "never") return !file.autoDeleteEnabled || file.retentionType === "never";
  return file.autoDeleteEnabled && file.retentionType === retention;
}

function matchesDerivedFilter(file: FileDocument, filter: FileFilter, now: Date, onlyAccessible = false): boolean {
  if (onlyAccessible && file.autoDeleteEnabled && file.deleteAt && file.deleteAt <= now) return false;
  if (filter === "auto_delete") return file.autoDeleteEnabled;
  if (filter === "never_delete") return !file.autoDeleteEnabled || file.retentionType === "never";
  if (filter === "expiring_soon") {
    const thirtyDays = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    return Boolean(file.autoDeleteEnabled && file.deleteAt && file.deleteAt > now && file.deleteAt <= thirtyDays);
  }
  if (filter === "expired") return Boolean(file.autoDeleteEnabled && file.deleteAt && file.deleteAt <= now);
  if (filter === "favorites") return file.isFavorite;
  if (filter === "recent") return file.createdAt.getTime() >= now.getTime() - 30 * 24 * 60 * 60 * 1000;
  return true;
}

function compareFiles(left: FileDocument, right: FileDocument, field: string, direction: "asc" | "desc"): number {
  const rawLeft = left[field as keyof FileDocument];
  const rawRight = right[field as keyof FileDocument];
  if (typeof rawLeft === "string" || typeof rawRight === "string") {
    const comparison = String(rawLeft ?? "").localeCompare(String(rawRight ?? ""));
    const tiebroken = comparison === 0 ? left.id.localeCompare(right.id) : comparison;
    return direction === "asc" ? tiebroken : -tiebroken;
  }
  const leftValue = rawLeft instanceof Date ? rawLeft.getTime() : typeof rawLeft === "number" ? rawLeft : rawLeft ? new Date(String(rawLeft)).getTime() : Number.POSITIVE_INFINITY;
  const rightValue = rawRight instanceof Date ? rawRight.getTime() : typeof rawRight === "number" ? rawRight : rawRight ? new Date(String(rawRight)).getTime() : Number.POSITIVE_INFINITY;
  const comparison = leftValue === rightValue ? left.id.localeCompare(right.id) : leftValue - rightValue;
  return direction === "asc" ? comparison : -comparison;
}

function encodeCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}

function decodeCursor(cursor?: string): string | undefined {
  if (!cursor) return undefined;
  try {
    const id = Buffer.from(cursor, "base64url").toString("utf8");
    return /^[A-Za-z0-9_-]{8,200}$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

export interface ListFilesInput {
  pageSize: number;
  cursor?: string;
  status: "all" | FileStatus;
  filter: FileFilter;
  sort: FileSort;
  search: string;
  category?: string;
  retention?: RetentionType | "";
  onlyAccessible?: boolean;
}

export interface ListFilesPagination {
  /** Number of documents returned on this page. */
  count: number;
  pageSize: number;
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ListFilesResult {
  files: SerializedFile[];
  nextCursor: string | null;
  searchLimited: boolean;
  /**
   * True when Firestore rejected the indexed query (missing composite index)
   * and the read was served from the bounded, index-free fallback below. The
   * page still shows real data; the operator gets a log line telling them
   * which index to deploy.
   */
  degraded: boolean;
  pagination: ListFilesPagination;
}

function collectionQuery(db: Firestore, status: "all" | FileStatus): Query {
  let query: Query = db.collection(FILES);
  if (status !== "all") query = query.where("status", "==", status);
  return query;
}

/** Log each missing-index fallback once per instance instead of on every request. */
const reportedMissingIndexes = new Set<string>();

function logMissingIndexFallback(operation: string, error: unknown): void {
  const failure = describeFailure(error, "firestore");
  const key = `${operation}:${failure.code}`;
  if (reportedMissingIndexes.has(key)) return;
  reportedMissingIndexes.add(key);
  logger.warn("Firestore query fell back to an index-free read", {
    operation,
    causeCode: failure.code,
    cause: failure.message,
    hint: failure.hint ?? "Deploy the missing composite index: npx firebase deploy --only firestore:indexes",
    indexBuildLink: indexBuildLink(failure.message) ?? null,
  });
}

/**
 * Bounded read used for search / derived filters.
 *
 * `where(status) + orderBy(createdAt)` needs the composite index declared in
 * `firestore.indexes.json`. When that index has not been deployed, Firestore
 * fails the whole query with FAILED_PRECONDITION — which previously took the
 * entire Files page down with an opaque "could not be loaded" error. The
 * single-field `status` index is created automatically, so the retry without
 * `orderBy` always succeeds and the ordering is applied in memory over the
 * same bounded window.
 */
async function readScanWindow(
  db: Firestore,
  status: "all" | FileStatus,
  limit: number,
  operation: string,
  /** Set when the caller already proved the composite index is missing. */
  indexKnownMissing = false,
): Promise<{ docs: DocumentSnapshot[]; degraded: boolean }> {
  const query = collectionQuery(db, status);
  if (indexKnownMissing) {
    const snapshot = await query.limit(limit).get();
    return { docs: snapshot.docs, degraded: true };
  }
  try {
    const snapshot = await query.orderBy("createdAt", "desc").limit(limit).get();
    return { docs: snapshot.docs, degraded: false };
  } catch (error) {
    if (!isMissingIndexError(error)) throw error;
    logMissingIndexFallback(operation, error);
    const snapshot = await query.limit(limit).get();
    return { docs: snapshot.docs, degraded: true };
  }
}

function listResult(files: SerializedFile[], nextCursor: string | null, searchLimited: boolean, degraded: boolean, pageSize: number): ListFilesResult {
  return {
    files,
    nextCursor,
    searchLimited,
    degraded,
    pagination: { count: files.length, pageSize, nextCursor, hasMore: nextCursor !== null },
  };
}

/** Index-backed page read (status + sort field composite index). */
async function listFilesIndexed(
  db: Firestore,
  input: ListFilesInput,
  resolvedStatus: "all" | FileStatus,
  order: { field: string; direction: "asc" | "desc" },
): Promise<ListFilesResult> {
  let query: Query = collectionQuery(db, resolvedStatus).orderBy(order.field, order.direction);
  const cursorId = decodeCursor(input.cursor);
  if (cursorId) {
    const cursor = await db.collection(FILES).doc(cursorId).get();
    if (cursor.exists) query = query.startAfter(cursor);
  }
  const snapshot = await query.limit(input.pageSize + 1).get();
  const visible = snapshot.docs.slice(0, input.pageSize).map(toDocument);
  return listResult(
    visible.map(serializeFile),
    snapshot.docs.length > input.pageSize ? encodeCursor(visible.at(-1)!.id) : null,
    false,
    false,
    input.pageSize,
  );
}

/**
 * Server-side search/filter without a separate search service: read a bounded
 * window of real documents, filter, then sort in memory.
 */
async function listFilesByScan(
  db: Firestore,
  input: ListFilesInput,
  resolvedStatus: "all" | FileStatus,
  order: { field: string; direction: "asc" | "desc" },
  indexKnownMissing = false,
): Promise<ListFilesResult> {
  const { docs, degraded } = await readScanWindow(db, resolvedStatus, SEARCH_SCAN_LIMIT, "files/list:scan", indexKnownMissing);
  const all = docs.map(toDocument)
    .filter((file) => matchesText(file, input.search))
    .filter((file) => matchesCategory(file, input.category))
    .filter((file) => matchesRetention(file, input.retention))
    .filter((file) => matchesDerivedFilter(file, input.filter, new Date(), input.onlyAccessible))
    .sort((left, right) => compareFiles(left, right, order.field, order.direction));
  const cursorId = decodeCursor(input.cursor);
  const start = cursorId ? Math.max(0, all.findIndex((file) => file.id === cursorId) + 1) : 0;
  const page = all.slice(start, start + input.pageSize);
  return listResult(
    page.map(serializeFile),
    start + input.pageSize < all.length ? encodeCursor(page.at(-1)!.id) : null,
    docs.length === SEARCH_SCAN_LIMIT,
    degraded,
    input.pageSize,
  );
}

/**
 * Lists real file metadata from the Firestore `files` collection.
 *
 * There is no fallback data source: either Firestore answers or the caller
 * gets a structured failure describing the real cause.
 */
export async function listFiles(input: ListFilesInput): Promise<ListFilesResult> {
  const db = getAdminDb();
  const resolvedStatus = statusFor(input);
  const needsDerivedScan = input.filter === "expiring_soon" || input.filter === "expired" || input.filter === "auto_delete" || input.filter === "never_delete" || input.filter === "favorites" || input.filter === "recent";
  const requiresScan = Boolean(input.search || input.category || input.retention) || needsDerivedScan || Boolean(input.onlyAccessible);
  const order = sortDefinition(input.sort, resolvedStatus);

  if (!requiresScan) {
    try {
      return await listFilesIndexed(db, input, resolvedStatus, order);
    } catch (error) {
      if (!isMissingIndexError(error)) throw error;
      logMissingIndexFallback("files/list:indexed", error);
      // Undeployed composite index: serve the same page from the index-free
      // read, and skip a second round trip we already know would fail.
      return listFilesByScan(db, input, resolvedStatus, order, true);
    }
  }
  return listFilesByScan(db, input, resolvedStatus, order);
}

export async function getRecentFiles(status: FileStatus, limit = 6): Promise<FileDocument[]> {
  const snapshot = await getAdminDb().collection(FILES)
    .where("status", "==", status)
    .orderBy(status === "trash" ? "deletedAt" : "createdAt", "desc")
    .limit(limit)
    .get();
  return snapshot.docs.map(toDocument);
}

export async function getExpiredActiveFiles(now: Date, limit = 500): Promise<FileDocument[]> {
  const snapshot = await getAdminDb().collection(FILES)
    .where("status", "==", "active")
    .where("autoDeleteEnabled", "==", true)
    .where("deleteAt", "<=", now)
    .orderBy("deleteAt", "asc")
    .limit(limit)
    .get();
  return snapshot.docs.map(toDocument);
}

export async function getExpiredTrashFiles(now: Date, limit = 500): Promise<FileDocument[]> {
  const snapshot = await getAdminDb().collection(FILES)
    .where("status", "==", "trash")
    .where("permanentDeleteAt", "<=", now)
    .orderBy("permanentDeleteAt", "asc")
    .limit(limit)
    .get();
  return snapshot.docs.map(toDocument);
}

export async function getStaleUploads(before: Date, limit = 100): Promise<FileDocument[]> {
  const snapshot = await getAdminDb().collection(FILES)
    .where("status", "==", "uploading")
    .where("uploadExpiresAt", "<=", before)
    .orderBy("uploadExpiresAt", "asc")
    .limit(limit)
    .get();
  return snapshot.docs.map(toDocument);
}

export async function getFailedUploadFiles(limit = 100): Promise<FileDocument[]> {
  const snapshot = await getAdminDb().collection(FILES).where("status", "==", "failed").limit(limit).get();
  return snapshot.docs.map(toDocument);
}

export async function getPendingPermanentDeletes(limit = 200): Promise<FileDocument[]> {
  const snapshot = await getAdminDb().collection(FILES).where("status", "==", "deleting").limit(limit).get();
  return snapshot.docs.map(toDocument);
}

export async function getUploadingFilesForReservation(limit = 1000): Promise<FileDocument[]> {
  const snapshot = await getAdminDb().collection(FILES).where("status", "==", "uploading").limit(limit).get();
  return snapshot.docs.map(toDocument);
}

export async function getActiveStagingFiles(limit = 100): Promise<FileDocument[]> {
  // This small system intentionally scans active metadata during daily cleanup;
  // it avoids a brittle Firestore inequality index and removes failed staging copies.
  const snapshot = await getAdminDb().collection(FILES).where("status", "==", "active").limit(1000).get();
  return snapshot.docs.map(toDocument).filter((file) => Boolean(file.uploadKey)).slice(0, limit);
}

export async function listFilesForStats(): Promise<FileDocument[]> {
  const snapshot = await getAdminDb().collection(FILES).where("status", "in", ["active", "trash"]).get();
  return snapshot.docs.map(toDocument);
}

export async function applyDefaultRetentionToActiveFiles(input: {
  autoDeleteEnabled: boolean;
  retentionType: Exclude<RetentionType, "custom_date">;
}): Promise<number> {
  const db = getAdminDb();
  const snapshot = await db.collection(FILES).where("status", "==", "active").get();
  const now = new Date();
  const deleteAt = calculateDeleteAt({ ...input, customDeleteAt: null }, now);
  const chunks: typeof snapshot.docs[] = [];
  for (let index = 0; index < snapshot.docs.length; index += 450) chunks.push(snapshot.docs.slice(index, index + 450));
  for (const documents of chunks) {
    const batch = db.batch();
    for (const document of documents) {
      batch.update(document.ref, {
        autoDeleteEnabled: input.autoDeleteEnabled,
        retentionType: input.retentionType,
        customDeleteAt: null,
        deleteAt,
        updatedAt: now,
      });
    }
    await batch.commit();
  }
  return snapshot.size;
}

/** Attach the canonical private Blob URL + verified size/hash after upload completion. */
export async function attachBlobIdentity(
  id: string,
  identity: { blobUrl?: string; size?: number; contentHash?: string | null },
): Promise<void> {
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (identity.blobUrl !== undefined) patch.blobUrl = identity.blobUrl;
  if (identity.size !== undefined) patch.size = identity.size;
  if (identity.contentHash !== undefined) patch.contentHash = identity.contentHash;
  await getAdminDb().collection(FILES).doc(id).set(patch, { merge: true });
}

export async function setFileFavorite(id: string, isFavorite: boolean): Promise<FileDocument> {
  const reference = getAdminDb().collection(FILES).doc(id);
  await reference.set({ isFavorite, updatedAt: new Date() }, { merge: true });
  const snapshot = await reference.get();
  return toDocument(snapshot);
}

/** Best-effort access tracking for preview/download analytics. Never throws. */
export async function recordFileAccess(id: string, kind: "preview" | "download"): Promise<void> {
  try {
    const patch: Record<string, unknown> = { lastAccessedAt: new Date(), updatedAt: new Date() };
    if (kind === "download") patch.lastDownloadedAt = new Date();
    await getAdminDb().collection(FILES).doc(id).set(patch, { merge: true });
  } catch {
    /* analytics must never break preview/download */
  }
}

/** Find an active file with identical content (duplicate detection). */
export async function findActiveFileByContentHash(contentHash: string): Promise<FileDocument | null> {
  const snapshot = await getAdminDb()
    .collection(FILES)
    .where("status", "==", "active")
    .where("contentHash", "==", contentHash)
    .limit(1)
    .get();
  const document = snapshot.docs[0];
  return document ? toDocument(document) : null;
}

/** Files whose retention expires within the given window (for notifications + retention views). */
export async function getFilesExpiringBetween(from: Date, to: Date, limit = 200): Promise<FileDocument[]> {
  const snapshot = await getAdminDb()
    .collection(FILES)
    .where("status", "==", "active")
    .where("autoDeleteEnabled", "==", true)
    .where("deleteAt", ">=", from)
    .where("deleteAt", "<=", to)
    .orderBy("deleteAt", "asc")
    .limit(limit)
    .get();
  return snapshot.docs.map(toDocument);
}

export async function getFavoriteFiles(limit = 200): Promise<FileDocument[]> {
  const snapshot = await getAdminDb()
    .collection(FILES)
    .where("status", "==", "active")
    .where("isFavorite", "==", true)
    .orderBy("updatedAt", "desc")
    .limit(limit)
    .get();
  return snapshot.docs.map(toDocument);
}
