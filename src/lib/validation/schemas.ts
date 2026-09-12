import { z } from "zod";
import { FILE_STATUSES, RETENTION_TYPES } from "@/types/file";
import { ROLES } from "@/types/auth";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_TOO_LONG_MESSAGE,
  PASSWORD_TOO_SHORT_MESSAGE,
} from "@/lib/auth/password-policy";

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
  // When true, the client uploads via the OIDC presigned client flow
  // (/api/blob/upload + uploadPresigned) and init skips minting a legacy
  // server-side presigned PUT URL.
  directToStorage: z.boolean().optional().default(false),
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
  // These are separate filters rather than part of the free-text query. Keeping
  // them separate prevents a category such as "Finance" from being treated as
  // a search term and makes the Files page filters deterministic.
  category: safeText(80).optional().default(""),
  retention: z.enum(["", ...RETENTION_TYPES]).optional().default(""),
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

/* ---------------------------------------------------------------------- */
/* Shared account field schemas                                            */
/* ---------------------------------------------------------------------- */

/**
 * Every account email is validated and normalized the same way: trimmed and
 * lower-cased, so `Admin@Example.org` and `admin@example.org` can never become
 * two different rows behind the case-insensitive unique index.
 */
export const emailSchema = z
  .string({ required_error: "Email address is required.", invalid_type_error: "Email address is required." })
  .trim()
  .min(1, "Email address is required.")
  .max(256, "Email address must be 256 characters or fewer.")
  .email("Enter a valid email address.")
  .transform((value) => value.toLowerCase());

/** A password being set, checked against the one shared policy. */
export const newPasswordSchema = z
  .string({ required_error: "Password is required.", invalid_type_error: "Password is required." })
  .min(PASSWORD_MIN_LENGTH, PASSWORD_TOO_SHORT_MESSAGE)
  .max(PASSWORD_MAX_LENGTH, PASSWORD_TOO_LONG_MESSAGE);

/** Role must be exactly one of the three supported values. */
// Zod v3 forbids combining `errorMap` with `required_error`/`invalid_type_error`,
// so a single error map covers the missing, wrong-type and unknown-value cases.
export const roleSchema = z.enum(ROLES, {
  errorMap: () => ({ message: "Role must be admin, editor, or viewer." }),
});

/**
 * Create-user payload for POST /api/users.
 *
 * `password` is optional: omitting it generates a temporary password instead.
 * An empty string is treated as "not provided" so a blank optional field in
 * the modal does not trip the minimum-length rule.
 */
export const createUserSchema = z.object({
  email: emailSchema,
  role: roleSchema,
  displayName: z.string().trim().max(120, "Display name must be 120 characters or fewer.").optional(),
  password: z.preprocess(
    (value) => (typeof value === "string" && value.length === 0 ? undefined : value),
    newPasswordSchema.optional(),
  ),
});

/** Admin-initiated password reset; an omitted password generates a temporary one. */
export const adminResetPasswordSchema = z.object({
  password: z.preprocess(
    (value) => (typeof value === "string" && value.length === 0 ? undefined : value),
    newPasswordSchema.optional(),
  ),
});

/** Role and/or account-enabled updates for PATCH /api/users/:uid. */
export const updateUserSchema = z
  .object({ role: roleSchema.optional(), disabled: z.boolean().optional() })
  .refine((data) => data.role !== undefined || data.disabled !== undefined, "Provide a role or a disabled flag to update.");


export const loginSchema = z.object({
  // Sign-in only checks that a password was supplied. The policy applies when a
  // password is *set*; rejecting an existing credential for length would leak
  // policy details and lock out accounts created under an older rule.
  email: emailSchema,
  password: z.string({ required_error: "Password is required." }).min(1, "Password is required.").max(PASSWORD_MAX_LENGTH),
});
export const passwordChangeSchema = z.object({
  currentPassword: z.string({ required_error: "Current password is required." }).min(1, "Current password is required.").max(PASSWORD_MAX_LENGTH),
  newPassword: newPasswordSchema,
});
export const passwordResetRequestSchema = z.object({ email: emailSchema });
export const passwordResetSchema = z.object({
  token: z.string().min(32, "This password reset link is invalid or expired.").max(256, "This password reset link is invalid or expired."),
  newPassword: newPasswordSchema,
});
export const moveToTrashSchema = z.object({ confirmation: z.literal("MOVE_TO_TRASH", { errorMap: () => ({ message: "Confirm moving this document to Trash." }) }) });
export const permanentDeleteSchema = z.object({ confirmation: z.literal("DELETE", { errorMap: () => ({ message: "Type DELETE to confirm." }) }) });
export const cleanupQuerySchema = z.object({ dryRun: z.enum(["true", "false"]).optional().default("false") });
