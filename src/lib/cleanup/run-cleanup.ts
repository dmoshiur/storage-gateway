import "server-only";

import { writeAuditLogSafely, auditActorFrom } from "@/lib/firestore/audit";
import { acquireCleanupLock, releaseCleanupLock } from "@/lib/firestore/cleanup-lock";
import {
  beginActivePermanentDeletion,
  beginPermanentDeletion,
  completePermanentDeletion,
  getActiveStagingFiles,
  getExpiredActiveFiles,
  getExpiredTrashFiles,
  getFailedUploadFiles,
  getPendingPermanentDeletes,
  getStaleUploads,
  markActivePermanentlyDeleted,
  markUploadFailed,
  markDeletedAfterFailedUpload,
  clearUploadKey,
  moveFileToTrash,
  revertActivePermanentDeletion,
  revertPermanentDeletion,
} from "@/lib/firestore/files";
import { getSettings } from "@/lib/firestore/settings";
import { logger } from "@/lib/logging/logger";
import { isDueForAutomaticCleanup, isDueForTrashExpiry, isStaleUpload } from "@/lib/cleanup/eligibility";
import { getStorageService } from "@/lib/storage";
import type { FileDocument } from "@/types/file";

const SYSTEM_ACTOR = { uid: "scheduled-cleanup", email: null, type: "system" as const };

export interface CleanupSummary {
  checked: number;
  movedToTrash: number;
  permanentlyDeleted: number;
  staleUploadsRemoved: number;
  failed: number;
  skipped: number;
  lockAcquired: boolean;
  dryRun: boolean;
}

async function auditFailure(file: FileDocument, stage: string): Promise<void> {
  await writeAuditLogSafely({
    action: "CLEANUP_FAILURE",
    actor: auditActorFrom(SYSTEM_ACTOR),
    fileId: file.id,
    fileName: file.originalName,
    details: { stage },
  });
}

async function permanentlyDeleteTrash(file: FileDocument, summary: CleanupSummary): Promise<void> {
  const storage = getStorageService();
  const pending = file.status === "deleting" ? file : await beginPermanentDeletion(file.id);
  if (pending.status === "deleted") {
    summary.skipped += 1;
    return;
  }
  try {
    // S3 DELETE is idempotent, so an interrupted completion is safely retried.
    await storage.delete(pending.storageKey);
    const deleted = await completePermanentDeletion(pending.id);
    summary.permanentlyDeleted += 1;
    await writeAuditLogSafely({ action: "TRASH_EXPIRY_DELETE", actor: auditActorFrom(SYSTEM_ACTOR), fileId: deleted.id, fileName: deleted.originalName });
  } catch (error) {
    try { await revertPermanentDeletion(pending.id, "R2_DELETE_FAILED"); } catch { /* retry stays pending if rollback fails */ }
    summary.failed += 1;
    logger.error("Cleanup permanent deletion failed", { fileId: pending.id, stage: "permanent_delete", error: error instanceof Error ? error.message : "unknown" });
    try { await auditFailure(pending, "permanent_delete"); } catch { /* preserve cleanup progress */ }
  }
}

async function permanentlyDeleteActive(file: FileDocument, summary: CleanupSummary): Promise<void> {
  const pending = await beginActivePermanentDeletion(file.id);
  if (pending.status === "deleted") { summary.skipped += 1; return; }
  try {
    await getStorageService().delete(pending.storageKey);
    const deleted = await markActivePermanentlyDeleted(pending.id);
    summary.permanentlyDeleted += 1;
    await writeAuditLogSafely({ action: "AUTO_DELETE", actor: auditActorFrom(SYSTEM_ACTOR), fileId: deleted.id, fileName: deleted.originalName, details: { outcome: "permanently_deleted" } });
  } catch (error) {
    try { await revertActivePermanentDeletion(pending.id, "R2_DELETE_FAILED"); } catch { /* retry handling logged below */ }
    summary.failed += 1;
    logger.error("Cleanup direct deletion failed", { fileId: pending.id, stage: "direct_delete", error: error instanceof Error ? error.message : "unknown" });
    try { await auditFailure(pending, "direct_delete"); } catch { /* continue */ }
  }
}

export async function runCleanup(options: { dryRun?: boolean } = {}): Promise<CleanupSummary> {
  const summary: CleanupSummary = {
    checked: 0,
    movedToTrash: 0,
    permanentlyDeleted: 0,
    staleUploadsRemoved: 0,
    failed: 0,
    skipped: 0,
    lockAcquired: false,
    dryRun: Boolean(options.dryRun),
  };

  const acquired = await acquireCleanupLock();
  summary.lockAcquired = acquired;
  if (!acquired) {
    summary.skipped = 1;
    return summary;
  }

  let releaseError: string | undefined;
  try {
    const now = new Date();
    const [settings, expiredActive, expiredTrash, staleUploads, failedUploads, pendingDeletes, activeStaging] = await Promise.all([
      getSettings(),
      getExpiredActiveFiles(now),
      getExpiredTrashFiles(now),
      getStaleUploads(now),
      getFailedUploadFiles(),
      getPendingPermanentDeletes(),
      getActiveStagingFiles(),
    ]);

    for (const file of expiredActive) {
      if (!isDueForAutomaticCleanup(file, now)) { summary.skipped += 1; continue; }
      summary.checked += 1;
      if (options.dryRun) { summary.skipped += 1; continue; }
      try {
        if (settings.trashEnabled) {
          const moved = await moveFileToTrash(file.id, settings.trashRetentionDays, "auto_retention");
          if (moved.status === "trash") {
            summary.movedToTrash += 1;
            await writeAuditLogSafely({ action: "AUTO_DELETE", actor: auditActorFrom(SYSTEM_ACTOR), fileId: moved.id, fileName: moved.originalName, details: { outcome: "moved_to_trash" } });
          } else summary.skipped += 1;
        } else {
          await permanentlyDeleteActive(file, summary);
        }
      } catch (error) {
        summary.failed += 1;
        logger.error("Cleanup retention action failed", { fileId: file.id, stage: "expired_active", error: error instanceof Error ? error.message : "unknown" });
        try { await auditFailure(file, "expired_active"); } catch { /* continue processing */ }
      }
    }

    const uniqueDeletes = new Map<string, FileDocument>();
    for (const file of [...expiredTrash, ...pendingDeletes]) uniqueDeletes.set(file.id, file);
    for (const file of uniqueDeletes.values()) {
      if (file.status !== "deleting" && !isDueForTrashExpiry(file, now)) { summary.skipped += 1; continue; }
      summary.checked += 1;
      if (options.dryRun) { summary.skipped += 1; continue; }
      await permanentlyDeleteTrash(file, summary);
    }

    const abandonedUploads = new Map<string, FileDocument>();
    for (const file of staleUploads) if (isStaleUpload(file, now)) abandonedUploads.set(file.id, file);
    for (const file of failedUploads) abandonedUploads.set(file.id, file);
    for (const file of abandonedUploads.values()) {
      summary.checked += 1;
      if (options.dryRun) { summary.skipped += 1; continue; }
      try {
        await getStorageService().delete(file.uploadKey ?? file.storageKey);
        if (file.status === "uploading") await markUploadFailed(file.id, "UPLOAD_EXPIRED");
        else await markDeletedAfterFailedUpload(file.id);
        summary.staleUploadsRemoved += 1;
        await writeAuditLogSafely({ action: "UPLOAD_FAILED", actor: auditActorFrom(SYSTEM_ACTOR), fileId: file.id, fileName: file.originalName, details: { reason: file.status === "uploading" ? "upload_expired" : "orphan_cleanup" } });
      } catch (error) {
        summary.failed += 1;
        logger.error("Cleanup stale upload failed", { fileId: file.id, stage: "stale_upload", error: error instanceof Error ? error.message : "unknown" });
        try { await auditFailure(file, "stale_upload"); } catch { /* continue processing */ }
      }
    }

    // Finalized records with a leftover staging key are safe to clean without touching the real PDF.
    for (const file of activeStaging) {
      summary.checked += 1;
      if (options.dryRun) { summary.skipped += 1; continue; }
      try {
        await getStorageService().delete(file.uploadKey!);
        await clearUploadKey(file.id);
      } catch (error) {
        summary.failed += 1;
        logger.error("Cleanup staging object failed", { fileId: file.id, stage: "staging_object", error: error instanceof Error ? error.message : "unknown" });
        try { await auditFailure(file, "staging_object"); } catch { /* continue */ }
      }
    }

    return summary;
  } catch (error) {
    releaseError = error instanceof Error ? error.message : "unknown";
    logger.error("Cleanup run failed before completion", { error: releaseError });
    throw error;
  } finally {
    await releaseCleanupLock({ ...summary }, releaseError);
  }
}
