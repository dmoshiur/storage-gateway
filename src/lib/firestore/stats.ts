import "server-only";

import { getUploadingFilesForReservation, listFilesForStats } from "@/lib/firestore/files";
import { getSettings } from "@/lib/firestore/settings";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { logger } from "@/lib/logging/logger";

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
    storageLimitBytes: settings.storageLimitBytes,
    activeStorageBytes,
    trashStorageBytes,
    availableBytes: Math.max(0, settings.storageLimitBytes - totalStorageBytes),
    usagePercent,
    warningLevel: usagePercent >= settings.criticalThresholdPercent ? "critical" : usagePercent >= settings.warningThresholdPercent ? "warning" : "normal",
    pendingUploadBytes,
    expiringSoonCount: active.filter((file) => file.autoDeleteEnabled && file.deleteAt && file.deleteAt > now && file.deleteAt <= inThirtyDays).length,
  };
}

export interface StorageStatsResult {
  stats: StorageStats;
  /** "live" = computed from Firestore metadata; "fallback" = degraded, non-authoritative metrics. */
  source: "live" | "fallback";
}

/** Explicitly marked degraded metrics used when the metadata service is unreachable. */
export function fallbackStorageStats(): StorageStats {
  return {
    totalPdfCount: 0,
    activeFileCount: 0,
    trashFileCount: 0,
    totalStorageBytes: 0,
    storageLimitBytes: DEFAULT_SETTINGS.storageLimitBytes,
    activeStorageBytes: 0,
    trashStorageBytes: 0,
    availableBytes: DEFAULT_SETTINGS.storageLimitBytes,
    usagePercent: 0,
    warningLevel: "normal",
    expiringSoonCount: 0,
    pendingUploadBytes: 0,
  };
}

/**
 * Dashboard-safe wrapper: any Firestore/Firebase failure (expired admin
 * token, network loss, missing configuration) returns explicitly marked
 * degraded summary metrics instead of throwing an unhandled exception that
 * would 500 the dashboard.
 */
export async function getStorageStatsSafe(): Promise<StorageStatsResult> {
  try {
    return { stats: await getStorageStats(), source: "live" };
  } catch (error) {
    logger.warn("Storage statistics unavailable — serving degraded metrics", {
      area: "stats",
      reason: error instanceof Error ? error.message : "unknown",
    });
    return { stats: fallbackStorageStats(), source: "fallback" };
  }
}
