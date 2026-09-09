import "server-only";

import type { DocumentSnapshot, Query } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { ApiError } from "@/lib/api/errors";
import { calculateDeleteAt, type RetentionInput } from "@/lib/retention";
import type { FileDocument, FileFilter, FileSort, FileStatus, RetentionType, SerializedFile } from "@/types/file";
import { asDate, toIso } from "@/utils/date";

const FILES = "files";
const SEARCH_SCAN_LIMIT = 1000;

function toDocument(snapshot: DocumentSnapshot): FileDocument {
  const data = snapshot.data();
  if (!data) throw new ApiError(404, "FILE_NOT_FOUND", "The requested PDF was not found.");
  return {
    id: snapshot.id,
    storageKey: String(data.storageKey),
    uploadKey: typeof data.uploadKey === "string" ? data.uploadKey : null,
    originalName: String(data.originalName),
    title: String(data.title ?? ""),
    description: String(data.description ?? ""),
    category: String(data.category ?? ""),
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    mimeType: "application/pdf",
    size: Number(data.size),
    createdAt: asDate(data.createdAt) ?? new Date(0),
    updatedAt: asDate(data.updatedAt) ?? new Date(0),
    uploadedBy: String(data.uploadedBy),
    autoDeleteEnabled: Boolean(data.autoDeleteEnabled),
    retentionType: data.retentionType as RetentionType,
    customDeleteAt: asDate(data.customDeleteAt),
    deleteAt: asDate(data.deleteAt),
    status: data.status as FileStatus,
    deletedAt: asDate(data.deletedAt),
    permanentDeleteAt: asDate(data.permanentDeleteAt),
    permanentlyDeletedAt: asDate(data.permanentlyDeletedAt),
    deletionStartedAt: asDate(data.deletionStartedAt),
    deletionPreviousStatus: data.deletionPreviousStatus === "active" || data.deletionPreviousStatus === "trash" ? data.deletionPreviousStatus : null,
    deletionReason: data.deletionReason ?? null,
    uploadExpiresAt: asDate(data.uploadExpiresAt),
    validatedAt: asDate(data.validatedAt),
    failureCode: data.failureCode ?? null,
    version: Number(data.version ?? 1),
  };
}

export function serializeFile(file: FileDocument): SerializedFile {
  // storageKey and upload lifecycle fields are intentionally never returned to browsers/integrations.
  return {
    id: file.id,
    originalName: file.originalName,
    title: file.title,
    description: file.description,
    category: file.category,
    tags: file.tags,
    mimeType: file.mimeType,
    size: file.size,
    createdAt: file.createdAt.toISOString(),
    updatedAt: file.updatedAt.toISOString(),
    autoDeleteEnabled: file.autoDeleteEnabled,
    retentionType: file.retentionType,
    customDeleteAt: toIso(file.customDeleteAt),
    deleteAt: toIso(file.deleteAt),
    status: file.status,
    deletedAt: toIso(file.deletedAt),
    permanentDeleteAt: toIso(file.permanentDeleteAt),
    permanentlyDeletedAt: toIso(file.permanentlyDeletedAt),
    deletionStartedAt: toIso(file.deletionStartedAt),
    deletionReason: file.deletionReason,
    failureCode: file.failureCode,
  };
}

function cleanFilename(name: string): string {
  return name.replace(/[\\/\0\r\n]/g, "_").trim().slice(0, 180) || "document.pdf";
}

export async function createUploadingFile(input: {
  storageKey: string;
  uploadKey: string;
  originalName: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  size: number;
  uploadedBy: string;
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
    storageKey: input.storageKey,
    uploadKey: input.uploadKey,
    originalName: cleanFilename(input.originalName),
    title: input.title,
    description: input.description,
    category: input.category,
    tags: [...new Set(input.tags.map((tag) => tag.toLowerCase()))],
    mimeType: "application/pdf",
    size: input.size,
    createdAt: now,
    updatedAt: now,
    uploadedBy: input.uploadedBy,
    ...retention,
    status: "uploading",
    deletedAt: null,
    permanentDeleteAt: null,
    permanentlyDeletedAt: null,
    deletionStartedAt: null,
    deletionPreviousStatus: null,
    deletionReason: null,
    uploadExpiresAt: new Date(now.getTime() + 20 * 60 * 1000),
    validatedAt: null,
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

export async function requireFileById(id: string): Promise<FileDocument> {
  const file = await getFileById(id);
  if (!file) throw new ApiError(404, "FILE_NOT_FOUND", "The requested PDF was not found.");
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
    if (file.status !== "active") throw new ApiError(409, "FILE_NOT_ACTIVE", "Only active PDFs can be edited.");
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

export async function moveFileToTrash(id: string, trashRetentionDays: number, reason: "manual" | "auto_retention"): Promise<FileDocument> {
  const db = getAdminDb();
  const reference = db.collection(FILES).doc(id);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const file = toDocument(snapshot);
    if (file.status === "trash") return file; // idempotent user retry
    if (file.status !== "active") throw new ApiError(409, "FILE_NOT_ACTIVE", "Only active PDFs can be moved to Trash.");
    const now = new Date();
    const permanentDeleteAt = new Date(now.getTime() + trashRetentionDays * 24 * 60 * 60 * 1000);
    const updates = { status: "trash" as const, deletedAt: now, permanentDeleteAt, deletionReason: reason, updatedAt: now, version: file.version + 1 };
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
    if (file.status !== "trash") throw new ApiError(409, "FILE_NOT_IN_TRASH", "Only PDFs in Trash can be restored.");
    const now = new Date();
    const updates = {
      status: "active" as const,
      deletedAt: null,
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
    if (file.status === "deleting") return file; // a retry may safely continue the R2 delete.
    if (file.status !== "trash") throw new ApiError(409, "FILE_NOT_IN_TRASH", "Move the PDF to Trash before permanently deleting it.");
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
    if (file.status !== "active") throw new ApiError(409, "FILE_NOT_ACTIVE", "This PDF cannot be permanently deleted in its current state.");
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
    if (file.status !== "deleting") throw new ApiError(409, "DELETE_NOT_PENDING", "This PDF is not awaiting permanent deletion.");
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
    if (file.status !== "active" && file.status !== "deleting") throw new ApiError(409, "FILE_NOT_ACTIVE", "This PDF cannot be permanently deleted in its current state.");
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
    default: return { field: "createdAt", direction: "desc" };
  }
}

function statusFor(input: { status: "all" | FileStatus; filter: FileFilter }): "all" | FileStatus {
  if (input.filter === "trash") return "trash";
  if (["active", "auto_delete", "never_delete", "expiring_soon", "expired"].includes(input.filter)) return "active";
  return input.status;
}

function matchesText(file: FileDocument, search: string): boolean {
  if (!search) return true;
  const needle = search.toLowerCase();
  return [file.originalName, file.title, file.description, file.category, ...file.tags]
    .some((value) => value.toLowerCase().includes(needle));
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
  return true;
}

function compareFiles(left: FileDocument, right: FileDocument, field: string, direction: "asc" | "desc"): number {
  const rawLeft = left[field as keyof FileDocument];
  const rawRight = right[field as keyof FileDocument];
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
  onlyAccessible?: boolean;
}

export async function listFiles(input: ListFilesInput): Promise<{ files: SerializedFile[]; nextCursor: string | null; searchLimited: boolean }> {
  const db = getAdminDb();
  const resolvedStatus = statusFor(input);
  const needsDerivedScan = input.filter === "expiring_soon" || input.filter === "expired" || input.filter === "auto_delete" || input.filter === "never_delete";
  const requiresScan = Boolean(input.search) || needsDerivedScan || Boolean(input.onlyAccessible);
  const order = sortDefinition(input.sort, resolvedStatus);
  let query: Query = db.collection(FILES);
  if (resolvedStatus !== "all") query = query.where("status", "==", resolvedStatus);

  if (requiresScan) {
    // Search/filter stays server-side for a small NGO dataset without a separate search service.
    const snapshot = await query.limit(SEARCH_SCAN_LIMIT).get();
    const all = snapshot.docs.map(toDocument)
      .filter((file) => matchesText(file, input.search))
      .filter((file) => matchesDerivedFilter(file, input.filter, new Date(), input.onlyAccessible))
      .sort((left, right) => compareFiles(left, right, order.field, order.direction));
    const cursorId = decodeCursor(input.cursor);
    const start = cursorId ? Math.max(0, all.findIndex((file) => file.id === cursorId) + 1) : 0;
    const page = all.slice(start, start + input.pageSize);
    return {
      files: page.map(serializeFile),
      nextCursor: start + input.pageSize < all.length ? encodeCursor(page.at(-1)!.id) : null,
      searchLimited: snapshot.docs.length === SEARCH_SCAN_LIMIT,
    };
  }

  query = query.orderBy(order.field, order.direction);
  const cursorId = decodeCursor(input.cursor);
  if (cursorId) {
    const cursor = await db.collection(FILES).doc(cursorId).get();
    if (cursor.exists) query = query.startAfter(cursor);
  }
  const snapshot = await query.limit(input.pageSize + 1).get();
  const visible = snapshot.docs.slice(0, input.pageSize).map(toDocument);
  return {
    files: visible.map(serializeFile),
    nextCursor: snapshot.docs.length > input.pageSize ? encodeCursor(visible.at(-1)!.id) : null,
    searchLimited: false,
  };
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
