import { z } from "zod";
import { FILE_STATUSES, RETENTION_TYPES } from "@/types/file";

const safeText = (max: number) => z.string().trim().max(max).transform((value) => value.replace(/\s+/g, " "));
const optionalText = (max: number) => safeText(max).optional().default("");
const tagText = z.string().trim().min(1, "Tag cannot be empty.").max(32).transform((value) => value.replace(/\s+/g, " "));

export const retentionInputSchema = z.object({
  autoDeleteEnabled: z.boolean(),
  retentionType: z.enum(RETENTION_TYPES),
  customDeleteAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date.").nullable().optional(),
}).superRefine((value, ctx) => {
  if (value.autoDeleteEnabled && value.retentionType === "custom_date" && !value.customDeleteAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["customDeleteAt"], message: "Choose a custom deletion date." });
  }
});

export const uploadInitSchema = z.object({
  originalName: safeText(180),
  size: z.number().int().positive().max(1024 * 1024 * 1024),
  // It is recorded only for diagnostics; server-side validation never trusts it.
  mimeType: z.string().max(100).optional(),
  title: optionalText(160),
  description: optionalText(2000),
  category: optionalText(80),
  tags: z.array(tagText).max(20).optional().default([]),
  // Optional client-computed SHA-256 hex of the bytes, used for duplicate detection hints only.
  contentHash: z.string().regex(/^[0-9a-f]{64}$/i, "Use a SHA-256 hex digest.").optional(),
  retention: retentionInputSchema.optional(),
});

export const completeUploadSchema = z.object({
  contentHash: z.string().regex(/^[0-9a-f]{64}$/i, "Use a SHA-256 hex digest.").optional(),
});

export const favoriteSchema = z.object({ isFavorite: z.boolean() });

export const fileUpdateSchema = z.object({
  title: safeText(160).optional(),
  description: safeText(2000).optional(),
  category: safeText(80).optional(),
  tags: z.array(tagText).max(20).optional(),
  retention: retentionInputSchema.optional(),
}).refine((data) => Object.keys(data).length > 0, "Provide at least one field to update.");

export const listFilesQuerySchema = z.object({
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(500).optional(),
  status: z.enum(["all", ...FILE_STATUSES]).default("active"),
  filter: z.enum(["all", "active", "trash", "auto_delete", "never_delete", "expiring_soon", "expired", "favorites", "recent"]).default("all"),
  sort: z.enum(["newest", "oldest", "largest", "smallest", "delete_date", "name"]).default("newest"),
  search: z.string().trim().max(100).optional().default(""),
});

const defaultRetentionTypes = ["never", "30_days", "3_months", "6_months", "1_year"] as const;
export const settingsPatchSchema = z.object({
  maxPdfSizeBytes: z.number().int().min(1024 * 1024).max(500 * 1024 * 1024),
  storageLimitBytes: z.number().int().min(1024 * 1024 * 1024).max(1024 * 1024 * 1024 * 1024),
  defaultAutoDelete: z.boolean(),
  defaultRetentionType: z.enum(defaultRetentionTypes),
  trashEnabled: z.boolean(),
  trashRetentionDays: z.number().int().min(1).max(365),
  signedUrlExpirySeconds: z.number().int().min(60).max(3600),
  warningThresholdPercent: z.number().int().min(1).max(98),
  criticalThresholdPercent: z.number().int().min(2).max(99),
  applyToExisting: z.boolean().optional().default(false),
}).superRefine((value, ctx) => {
  if (value.warningThresholdPercent >= value.criticalThresholdPercent) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["criticalThresholdPercent"], message: "Critical threshold must be higher than warning threshold." });
  }
});

export const sessionSchema = z.object({ idToken: z.string().min(100).max(12_000) });
export const adminPassSchema = z.object({ adminPass: z.string().min(1).max(256) });
export const moveToTrashSchema = z.object({ confirmation: z.literal("MOVE_TO_TRASH", { errorMap: () => ({ message: "Confirm moving this document to Trash." }) }) });
export const permanentDeleteSchema = z.object({ confirmation: z.literal("DELETE", { errorMap: () => ({ message: "Type DELETE to confirm." }) }) });
export const cleanupQuerySchema = z.object({ dryRun: z.enum(["true", "false"]).optional().default("false") });
