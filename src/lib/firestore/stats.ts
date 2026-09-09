import "server-only";

import { getUploadingFilesForReservation, listFilesForStats } from "@/lib/firestore/files";
import { getSettings } from "@/lib/firestore/settings";

export interface StorageStats {
  totalPdfCount: number;
  activeFileCount: number;
  trashFileCount: number;
  totalStorageBytes: number;
  activeStorageBytes: number;
  trashStorageBytes: number;
  availableBytes: number;
  usagePercent: number;
  warningLevel: "normal" | "warning" | "critical";
  expiringSoonCount: number;
  pendingUploadBytes: number;
}

/** Metadata-only calculation. At this <=10 GB scale it avoids a second service. */
export async function getStorageStats(): Promise<StorageStats> {
  const [files, uploading, settings] = await Promise.all([listFilesForStats(), getUploadingFilesForReservation(), getSettings()]);
  const now = new Date();
  const inThirtyDays = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const active = files.filter((file) => file.status === "active");
  const trash = files.filter((file) => file.status === "trash");
  const activeStorageBytes = active.reduce((sum, file) => sum + file.size, 0);
  const trashStorageBytes = trash.reduce((sum, file) => sum + file.size, 0);
  const totalStorageBytes = activeStorageBytes + trashStorageBytes;
  const pendingUploadBytes = uploading.reduce((sum, file) => sum + file.size, 0);
  const usagePercent = settings.storageLimitBytes ? Math.min(100, Math.round((totalStorageBytes / settings.storageLimitBytes) * 1000) / 10) : 0;
  return {
    totalPdfCount: files.length,
    activeFileCount: active.length,
    trashFileCount: trash.length,
    totalStorageBytes,
    activeStorageBytes,
    trashStorageBytes,
    availableBytes: Math.max(0, settings.storageLimitBytes - totalStorageBytes),
    usagePercent,
    warningLevel: usagePercent >= settings.criticalThresholdPercent ? "critical" : usagePercent >= settings.warningThresholdPercent ? "warning" : "normal",
    pendingUploadBytes,
    expiringSoonCount: active.filter((file) => file.autoDeleteEnabled && file.deleteAt && file.deleteAt > now && file.deleteAt <= inThirtyDays).length,
  };
}
