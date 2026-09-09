import { z } from "zod";

/**
 * Server-to-server bridge payloads. These routes are only reachable with the
 * INTEGRATION_API_KEY header and are never called from a browser, so the
 * payloads deliberately stay small and strictly typed.
 */

/** Matches the final object layout produced by the app and the FastAPI bridge. */
export const bridgeStorageKeySchema = z
  .string()
  .min(1)
  .max(300)
  .regex(/^pdfs\/\d{4}\/\d{2}\/[A-Za-z0-9_-]{8,200}\.pdf$/, "The storage key is invalid.");

const safeBridgeText = (max: number) => z.string().trim().max(max).transform((value) => value.replace(/\s+/g, " "));
const optionalBridgeText = (max: number) => safeBridgeText(max).optional().default("");
const bridgeTag = z.string().trim().min(1, "Tag cannot be empty.").max(32).transform((value) => value.replace(/\s+/g, " "));

export const bridgeVerifyKeySchema = z.object({
  key: z.string().min(1).max(200),
});

export const bridgeRegisterFileSchema = z.object({
  storageKey: bridgeStorageKeySchema,
  originalName: safeBridgeText(180),
  title: optionalBridgeText(160),
  description: optionalBridgeText(2000),
  category: optionalBridgeText(80),
  tags: z.array(bridgeTag).max(20).optional().default([]),
  size: z.number().int().positive().max(1024 * 1024 * 1024),
});
