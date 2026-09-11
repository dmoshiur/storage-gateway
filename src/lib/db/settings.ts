import "server-only";

import { query, toDate, withTransaction } from "@/lib/db/client";
import { DEFAULT_SETTINGS, type AppSettings, type SerializedSettings } from "@/types/settings";
import type { RetentionType } from "@/types/file";

const SETTINGS_KEY = "app";
const DEFAULT_RULE_NAME = "default";
type DefaultRetentionType = Exclude<RetentionType, "custom_date">;

function isDefaultRetentionType(value: unknown): value is DefaultRetentionType {
  return value === "never" || value === "30_days" || value === "3_months" || value === "6_months" || value === "1_year";
}

function retentionDays(type: DefaultRetentionType): number | null {
  switch (type) {
    case "30_days": return 30;
    case "3_months": return 90;
    case "6_months": return 180;
    case "1_year": return 365;
    default: return null;
  }
}

function normalize(value: unknown, ruleValue: unknown): AppSettings {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const configured = isDefaultRetentionType(raw.defaultRetentionType) ? raw.defaultRetentionType : DEFAULT_SETTINGS.defaultRetentionType;
  const retention = isDefaultRetentionType(ruleValue) ? ruleValue : configured;
  return {
    ...DEFAULT_SETTINGS,
    maxPdfSizeBytes: typeof raw.maxPdfSizeBytes === "number" ? raw.maxPdfSizeBytes : DEFAULT_SETTINGS.maxPdfSizeBytes,
    storageLimitBytes: typeof raw.storageLimitBytes === "number" ? raw.storageLimitBytes : DEFAULT_SETTINGS.storageLimitBytes,
    defaultAutoDelete: typeof raw.defaultAutoDelete === "boolean" ? raw.defaultAutoDelete : DEFAULT_SETTINGS.defaultAutoDelete,
    defaultRetentionType: retention,
    trashEnabled: typeof raw.trashEnabled === "boolean" ? raw.trashEnabled : DEFAULT_SETTINGS.trashEnabled,
    trashRetentionDays: typeof raw.trashRetentionDays === "number" ? raw.trashRetentionDays : DEFAULT_SETTINGS.trashRetentionDays,
    signedUrlExpirySeconds: typeof raw.signedUrlExpirySeconds === "number" ? raw.signedUrlExpirySeconds : DEFAULT_SETTINGS.signedUrlExpirySeconds,
    warningThresholdPercent: typeof raw.warningThresholdPercent === "number" ? raw.warningThresholdPercent : DEFAULT_SETTINGS.warningThresholdPercent,
    criticalThresholdPercent: typeof raw.criticalThresholdPercent === "number" ? raw.criticalThresholdPercent : DEFAULT_SETTINGS.criticalThresholdPercent,
    ...(toDate(raw.updatedAt) ? { updatedAt: toDate(raw.updatedAt)! } : {}),
    ...(typeof raw.updatedBy === "string" ? { updatedBy: raw.updatedBy } : {}),
  };
}

export async function getSettings(): Promise<AppSettings> {
  const [settingsResult, ruleResult] = await Promise.all([
    query<{ value: unknown; updated_at: Date; updated_by: string | null }>(
      `SELECT value, updated_at, updated_by FROM system_settings WHERE key = $1`,
      [SETTINGS_KEY],
    ),
    query<{ retention_type: string }>(
      `SELECT retention_type FROM retention_rules
       WHERE lower(name) = lower($1) AND enabled = true
       ORDER BY updated_at DESC LIMIT 1`,
      [DEFAULT_RULE_NAME],
    ),
  ]);
  const row = settingsResult.rows[0];
  const settings = normalize(row?.value, ruleResult.rows[0]?.retention_type);
  if (row) {
    settings.updatedAt = toDate(row.updated_at) ?? undefined;
    settings.updatedBy = row.updated_by ?? undefined;
  }
  return settings;
}

export async function updateSettings(settings: AppSettings, actorUid: string): Promise<AppSettings> {
  const updatedAt = new Date();
  const next: AppSettings = { ...settings, updatedAt, updatedBy: actorUid };
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO system_settings(key, value, updated_at, updated_by)
       VALUES ($1, $2::jsonb, $3, $4)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
      [SETTINGS_KEY, JSON.stringify(next), updatedAt, actorUid],
    );
    await client.query(
      `INSERT INTO retention_rules(name, enabled, retention_type, days, created_by, updated_at)
       VALUES ($1, true, $2, $3, $4, $5)
       ON CONFLICT (lower(name)) DO UPDATE SET
         enabled = true,
         retention_type = EXCLUDED.retention_type,
         days = EXCLUDED.days,
         updated_at = EXCLUDED.updated_at,
         created_by = EXCLUDED.created_by`,
      [DEFAULT_RULE_NAME, next.defaultRetentionType, retentionDays(next.defaultRetentionType), actorUid, updatedAt],
    );
  });
  return next;
}

export function serializeSettings(settings: AppSettings): SerializedSettings {
  const { updatedAt, ...rest } = settings;
  return { ...rest, ...(updatedAt ? { updatedAt: updatedAt.toISOString() } : {}) };
}
