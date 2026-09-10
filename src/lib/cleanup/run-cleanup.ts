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
import { getStorageStats } from "@/lib/firestore/stats";
import { createNotificationSafe, pruneNotifications } from "@/lib/firestore/notifications";
import { emitWebhookEvent } from "@/lib/webhooks/dispatch";
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
    // Blob DELETE is idempotent, so an interrupted completion is safely retried.
    await storage.delete(pending.storagePath);
    const deleted = await completePermanentDeletion(pending.id);
    summary.permanentlyDeleted += 1;
    await writeAuditLogSafely({ action: "TRASH_EXPIRY_DELETE", actor: auditActorFrom(SYSTEM_ACTOR), fileId: deleted.id, fileName: deleted.originalName });
  } catch (error) {
    try { await revertPermanentDeletion(pending.id, "BLOB_DELETE_FAILED"); } catch { /* retry stays pending if rollback fails */ }
    summary.failed += 1;
    logger.error("Cleanup permanent deletion failed", { fileId: pending.id, stage: "permanent_delete", error: error instanceof Error ? error.message : "unknown" });
    try { await auditFailure(pending, "permanent_delete"); } catch { /* preserve cleanup progress */ }
  }
}

async function permanentlyDeleteActive(file: FileDocument, summary: CleanupSummary): Promise<void> {
  const pending = await beginActivePermanentDeletion(file.id);
  if (pending.status === "deleted") { summary.skipped += 1; return; }
  try {
    await getStorageService().delete(pending.storagePath);
    const deleted = await markActivePermanentlyDeleted(pending.id);
    summary.permanentlyDeleted += 1;
    await writeAuditLogSafely({ action: "AUTO_DELETE", actor: auditActorFrom(SYSTEM_ACTOR), fileId: deleted.id, fileName: deleted.originalName, details: { outcome: "permanently_deleted" } });
  } catch (error) {
    try { await revertActivePermanentDeletion(pending.id, "BLOB_DELETE_FAILED"); } catch { /* retry handling logged below */ }
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
        await getStorageService().delete(file.uploadKey ?? file.storagePath);
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

    if (!options.dryRun) await emitRunNotifications(summary);

    // Finalized records with a leftover staging key are safe to clean without touching the real document.
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
    if (!options.dryRun) {
      try { await pruneNotifications(); } catch { /* best-effort */ }
    }
    await releaseCleanupLock({ ...summary }, releaseError);
  }
}

/** Post-run notifications: summary, failures, storage thresholds, expiring files. Never throws. */
async function emitRunNotifications(summary: CleanupSummary): Promise<void> {
  try {
    if (summary.failed > 0) {
      await createNotificationSafe({
        type: "cleanup_failed",
        title: "Scheduled cleanup reported failures",
        message: `${summary.failed} item(s) failed during automatic cleanup. Review the audit log for details.`,
        link: "/admin/audit",
      });
    } else if (summary.movedToTrash + summary.permanentlyDeleted + summary.staleUploadsRemoved > 0) {
      await createNotificationSafe({
        type: "cleanup_completed",
        title: "Scheduled cleanup completed",
        message: `${summary.movedToTrash} moved to Trash, ${summary.permanentlyDeleted} permanently deleted, ${summary.staleUploadsRemoved} stale uploads removed.`,
        link: "/admin/activity",
      });
    }
    const stats = await getStorageStats().catch(() => null);
    if (stats) {
      if (stats.warningLevel === "critical") {
        await createNotificationSafe({
          type: "storage_critical",
          title: "Storage critically full",
          message: `Storage is ${stats.usagePercent}% full. Uploads may soon be rejected.`,
          link: "/admin/storage",
          dedupeKey: "storage-critical",
        });
      } else if (stats.warningLevel === "warning") {
        await createNotificationSafe({
          type: "storage_warning",
          title: "Storage almost full",
          message: `Storage is ${stats.usagePercent}% full. Consider raising the limit or cleaning up.`,
          link: "/admin/storage",
          dedupeKey: "storage-warning",
        });
      }
      if (stats.expiringSoonCount > 0) {
        await createNotificationSafe({
          type: "file_expiring",
          title: "Files expiring soon",
          message: `${stats.expiringSoonCount} file(s) will be automatically moved to Trash within 30 days.`,
          link: "/admin/retention",
          dedupeKey: "expiring-30d",
        });
      }
    }
  } catch {
    /* notifications never break cleanup */
  }
}
