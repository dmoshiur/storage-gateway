import "server-only";

import { getUploadingFilesForReservation, listFilesForStats } from "@/lib/db/files";
import { getSettings } from "@/lib/db/settings";

export interface StorageStats {
  totalPdfCount: number;
  activeFileCount: number;
  trashFileCount: number;
  totalStorageBytes: number;
  storageLimitBytes: number;
  activeStorageBytes: number;
  trashStorageBytes: number;
  availableBytes: number;
  usagePercent: number;
  warningLevel: "normal" | "warning" | "critical";
  expiringSoonCount: number;
  pendingUploadBytes: number;
}

/** Compute storage metrics exclusively from PostgreSQL metadata and settings. */
export async function getStorageStats(): Promise<StorageStats> {
  const [files, uploading, settings] = await Promise.all([listFilesForStats(), getUploadingFilesForReservation(), getSettings()]);
  const now = new Date();
  const active = files.filter((file) => file.status === "active");
  const trash = files.filter((file) => file.status === "trash");
  const activeStorageBytes = active.reduce((sum, file) => sum + file.size, 0);
  const trashStorageBytes = trash.reduce((sum, file) => sum + file.size, 0);
  const totalStorageBytes = activeStorageBytes + trashStorageBytes;
  const usagePercent = settings.storageLimitBytes ? Math.min(100, Math.round((totalStorageBytes / settings.storageLimitBytes) * 1000) / 10) : 0;
  return {
    totalPdfCount: files.length,
    activeFileCount: active.length,
    trashFileCount: trash.length,
    totalStorageBytes,
    storageLimitBytes: settings.storageLimitBytes,
    activeStorageBytes,
    trashStorageBytes,
    availableBytes: Math.max(0, settings.storageLimitBytes - totalStorageBytes),
    usagePercent,
    warningLevel: usagePercent >= settings.criticalThresholdPercent ? "critical" : usagePercent >= settings.warningThresholdPercent ? "warning" : "normal",
    pendingUploadBytes: uploading.reduce((sum, file) => sum + file.size, 0),
    expiringSoonCount: active.filter((file) => file.autoDeleteEnabled && file.deleteAt && file.deleteAt > now && file.deleteAt <= new Date(now.getTime() + 30 * 86400000)).length,
  };
}
