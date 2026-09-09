import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { DEFAULT_SETTINGS, type AppSettings, type SerializedSettings } from "@/types/settings";
import { asDate } from "@/utils/date";

const SETTINGS_DOCUMENT = "app";

function normalizeSettings(value: Record<string, unknown> | undefined): AppSettings {
  const raw = value ?? {};
  return {
    ...DEFAULT_SETTINGS,
    maxPdfSizeBytes: typeof raw.maxPdfSizeBytes === "number" ? raw.maxPdfSizeBytes : DEFAULT_SETTINGS.maxPdfSizeBytes,
    storageLimitBytes: typeof raw.storageLimitBytes === "number" ? raw.storageLimitBytes : DEFAULT_SETTINGS.storageLimitBytes,
    defaultAutoDelete: typeof raw.defaultAutoDelete === "boolean" ? raw.defaultAutoDelete : DEFAULT_SETTINGS.defaultAutoDelete,
    defaultRetentionType: typeof raw.defaultRetentionType === "string" && raw.defaultRetentionType !== "custom_date"
      ? raw.defaultRetentionType as AppSettings["defaultRetentionType"]
      : DEFAULT_SETTINGS.defaultRetentionType,
    trashEnabled: typeof raw.trashEnabled === "boolean" ? raw.trashEnabled : DEFAULT_SETTINGS.trashEnabled,
    trashRetentionDays: typeof raw.trashRetentionDays === "number" ? raw.trashRetentionDays : DEFAULT_SETTINGS.trashRetentionDays,
    signedUrlExpirySeconds: typeof raw.signedUrlExpirySeconds === "number" ? raw.signedUrlExpirySeconds : DEFAULT_SETTINGS.signedUrlExpirySeconds,
    warningThresholdPercent: typeof raw.warningThresholdPercent === "number" ? raw.warningThresholdPercent : DEFAULT_SETTINGS.warningThresholdPercent,
    criticalThresholdPercent: typeof raw.criticalThresholdPercent === "number" ? raw.criticalThresholdPercent : DEFAULT_SETTINGS.criticalThresholdPercent,
    ...(asDate(raw.updatedAt) ? { updatedAt: asDate(raw.updatedAt)! } : {}),
    ...(typeof raw.updatedBy === "string" ? { updatedBy: raw.updatedBy } : {}),
  };
}

export async function getSettings(): Promise<AppSettings> {
  const snapshot = await getAdminDb().collection("settings").doc(SETTINGS_DOCUMENT).get();
  return normalizeSettings(snapshot.data());
}

export async function updateSettings(settings: AppSettings, actorUid: string): Promise<AppSettings> {
  const updatedAt = new Date();
  const next: AppSettings = { ...settings, updatedAt, updatedBy: actorUid };
  await getAdminDb().collection("settings").doc(SETTINGS_DOCUMENT).set(next, { merge: true });
  return next;
}

export function serializeSettings(settings: AppSettings): SerializedSettings {
  const { updatedAt, ...rest } = settings;
  return { ...rest, ...(updatedAt ? { updatedAt: updatedAt.toISOString() } : {}) };
}
