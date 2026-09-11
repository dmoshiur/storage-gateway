import { z } from "zod";

/**
 * Server-to-server bridge payloads. These routes require a PostgreSQL-backed
 * API key and are never called from a browser, so payloads stay small and
 * strictly typed.
 */

/** Matches the final object layout produced by the app and both bridge flavors. */
export const bridgeStorageKeySchema = z
  .string()
  .min(1)
  .max(300)
  .regex(
    /^pdfs\/\d{4}\/\d{2}\/[A-Za-z0-9_-]{8,200}\.pdf$/,
    "The storage key is invalid.",
  );

const safeBridgeText = (max: number) => z.string().trim().max(max).transform((value) => value.replace(/\s+/g, " "));
const optionalBridgeText = (max: number) => safeBridgeText(max).optional().default("");
const bridgeTag = z.string().trim().min(1, "Tag cannot be empty.").max(32).transform((value) => value.replace(/\s+/g, " "));

const bridgeKeyId = z
  .string()
  .trim()
  .regex(/^am_store_live_[A-Za-z0-9_-]{8,32}$/, "The API key id is invalid.");

/**
 * Key verification payloads accepted from the bridge. Both forms are checked
 * against one-way digests in PostgreSQL; raw secrets are never persisted.
 */
export const bridgeVerifyKeySchema = z.union([
  z
    .object({
      mode: z.literal("dual_token"),
      keyId: bridgeKeyId,
      secret: z.string().min(24).max(200),
    })
    .strict(),
  z
    .object({
      key: z.string().min(1).max(200),
    })
    .strict(),
]);

export type BridgeVerifyKeyInput = z.infer<typeof bridgeVerifyKeySchema>;

/** Bridge upload-attempt log entry (success or failure) for the dashboard. */
export const bridgeUploadLogSchema = z.object({
  keyId: z.string().trim().min(1).max(80),
  filename: z.string().trim().min(1).max(180),
  sizeBytes: z.number().int().min(0).max(1024 * 1024 * 1024),
  status: z.enum(["success", "failed"]),
  failureCode: z.string().trim().min(1).max(64).nullish().transform((value) => value ?? null),
  requestId: z.string().trim().min(1).max(96),
  timestamp: z.string().datetime({ offset: true }).or(z.string().datetime()),
});

/**
 * Step 1 of the embedded bridge's presigned flow (`POST /api/v1/storage/upload/init`).
 * The integration declares the document up front and receives a short-lived Blob
 * PUT URL, so bytes for large documents stream straight to Blob instead of
 * passing through the Vercel function payload.
 */
export const bridgeUploadInitSchema = z.object({
  originalName: safeBridgeText(180),
  size: z.number().int().positive().max(1024 * 1024 * 1024),
  // Recorded only for diagnostics; server-side validation never trusts it.
  mimeType: z.string().trim().max(100).optional().default(""),
  title: optionalBridgeText(160),
  description: optionalBridgeText(2000),
  category: optionalBridgeText(80),
  tags: z.array(bridgeTag).max(20).optional().default([]),
});

export type BridgeUploadInitInput = z.infer<typeof bridgeUploadInitSchema>;

/** Step 3 of the presigned flow (`POST /api/v1/storage/upload/complete`). */
export const bridgeUploadCompleteSchema = z
  .object({
    fileId: z.string().regex(/^[A-Za-z0-9_-]{8,200}$/, "The file identifier is invalid."),
  })
  .strict();

export type BridgeUploadCompleteInput = z.infer<typeof bridgeUploadCompleteSchema>;

export const bridgeRegisterFileSchema = z.object({
  storagePath: bridgeStorageKeySchema,
  originalName: safeBridgeText(180),
  title: optionalBridgeText(160),
  description: optionalBridgeText(2000),
  category: optionalBridgeText(80),
  tags: z.array(bridgeTag).max(20).optional().default([]),
  mimeType: z.literal("application/pdf").optional().default("application/pdf"),
  extension: z.literal("pdf").optional().default("pdf"),
  size: z.number().int().positive().max(1024 * 1024 * 1024),
});
