import type { RetentionType } from "@/types/file";

export interface AppSettings {
  maxPdfSizeBytes: number;
  storageLimitBytes: number;
  defaultAutoDelete: boolean;
  defaultRetentionType: Exclude<RetentionType, "custom_date">;
  trashEnabled: boolean;
  trashRetentionDays: number;
  signedUrlExpirySeconds: number;
  warningThresholdPercent: number;
  criticalThresholdPercent: number;
  updatedAt?: Date;
  updatedBy?: string;
}

export interface SerializedSettings extends Omit<AppSettings, "updatedAt"> {
  updatedAt?: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  maxPdfSizeBytes: 50 * 1024 * 1024,
  storageLimitBytes: 10 * 1024 * 1024 * 1024,
  defaultAutoDelete: false,
  defaultRetentionType: "6_months",
  trashEnabled: true,
  trashRetentionDays: 30,
  signedUrlExpirySeconds: 10 * 60,
  warningThresholdPercent: 80,
  criticalThresholdPercent: 90,
};
