import "server-only";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ApiError } from "@/lib/api/errors";

const firebaseAdminSchema = z.object({
  FIREBASE_PROJECT_ID: z.string().min(1),
  FIREBASE_CLIENT_EMAIL: z.string().email(),
  FIREBASE_PRIVATE_KEY: z.string().min(32),
});

const blobSchema = z.object({
  BLOB_READ_WRITE_TOKEN: z.string().min(1).optional(),
  BLOB_STORE_ID: z.string().min(1).optional(),
});

function configurationError(area: string, issues: string[]): never {
  // Details are intentionally logged server-side but not sent to callers.
  console.error(JSON.stringify({ level: "error", message: "Missing server configuration", area, issues }));
  throw new ApiError(503, "SERVICE_CONFIGURATION_ERROR", "This service is not configured yet. Contact an administrator.");
}

export function getFirebaseAdminEnv() {
  const parsed = firebaseAdminSchema.safeParse({
    FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
    FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY,
  });
  if (!parsed.success) return configurationError("firebase", parsed.error.issues.map((issue) => issue.path.join(".")));
  return { ...parsed.data, FIREBASE_PRIVATE_KEY: parsed.data.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n") };
}

/**
 * Vercel Private Blob store configuration (server only).
 *
 * When the Vercel Blob integration is attached, `BLOB_READ_WRITE_TOKEN` is
 * injected automatically. On Vercel runtimes without an explicit token, the
 * SDK authenticates with OIDC (`VERCEL_OIDC_TOKEN` + `BLOB_STORE_ID`).
 */
export function getBlobStoreConfig(): { token: string | null; storeId: string | null; oidcToken: string | null } {
  const parsed = blobSchema.safeParse({
    BLOB_READ_WRITE_TOKEN: process.env.BLOB_READ_WRITE_TOKEN || undefined,
    BLOB_STORE_ID: process.env.BLOB_STORE_ID || undefined,
  });
  if (!parsed.success) return configurationError("blob", parsed.error.issues.map((issue) => issue.path.join(".")));
  const explicitToken = parsed.data.BLOB_READ_WRITE_TOKEN ?? null;
  const oidcToken = process.env.VERCEL_OIDC_TOKEN?.trim() || null;
  if (!explicitToken && !oidcToken) {
    return configurationError("blob", ["BLOB_READ_WRITE_TOKEN or VERCEL_OIDC_TOKEN"]);
  }
  if (!explicitToken && oidcToken && !parsed.data.BLOB_STORE_ID) {
    return configurationError("blob", ["BLOB_STORE_ID"]);
  }
  return { token: explicitToken, storeId: parsed.data.BLOB_STORE_ID ?? null, oidcToken };
}

export function getRequiredSecret(name: "INTEGRATION_API_KEY" | "CRON_SECRET"): string {
  const value = process.env[name];
  if (!value || value.length < 24) return configurationError("secret", [name]);
  return value;
}

/**
 * Optional 32-byte (base64) master key for API-secret encryption at rest.
 * When present, dual-token keys store an AES-256-GCM copy of the secret so
 * HMAC signed requests can be verified; when absent, dual-token header mode
 * still works (digest only) and signature mode reports as unavailable.
 */
export function getMasterKey(): Buffer | null {
  const value = process.env.AM_STORAGE_MASTER_KEY;
  if (!value) return null;
  const key = Buffer.from(value.trim(), "base64");
  return key.length === 32 ? key : null;
}

/**
 * Base URL of an optional external (legacy FastAPI) bridge, used by the
 * dashboard's connectivity probe. Falls back to the public
 * NEXT_PUBLIC_BRIDGE_URL value when no dedicated server-only variable is set.
 * When unset, the embedded bridge serves all traffic in this deployment.
 */
export function getBridgeUrl(): string | null {
  const value = (process.env.BRIDGE_URL ?? process.env.NEXT_PUBLIC_BRIDGE_URL ?? "").trim().replace(/\/+$/, "");
  return value || null;
}

/** Required shared administrator passphrase. It gates access to the admin sign-in form. */
export function getAdminPass(): string {
  const value = process.env.ADMIN_PASS;
  if (!value || value.length < 8) return configurationError("secret", ["ADMIN_PASS"]);
  return value;
}

/** Constant-time comparison so a missing/mismatched passphrase cannot be distinguished by timing. */
export function verifyAdminPass(candidate: string): boolean {
  const expected = Buffer.from(getAdminPass());
  const supplied = Buffer.from(candidate);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function getAdminEmails(): Set<string> {
  return new Set(
    (process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}
