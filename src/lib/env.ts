import "server-only";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ApiError } from "@/lib/api/errors";

const firebaseAdminSchema = z.object({
  FIREBASE_PROJECT_ID: z.string().min(1),
  FIREBASE_CLIENT_EMAIL: z.string().email(),
  FIREBASE_PRIVATE_KEY: z.string().min(32),
});

function configurationError(area: string, issues: string[], publicMessage?: string): never {
  console.error(JSON.stringify({ level: "error", message: "Missing server configuration", area, issues }));
  throw new ApiError(
    503,
    "SERVICE_CONFIGURATION_ERROR",
    publicMessage ?? `Missing server configuration for ${area}: ${issues.join(", ")}.`,
  );
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
 *
 * Supports prefixed environment variables generated when connecting a store
 * with a custom prefix or store name (e.g., `TBLOB_STORE_ID`, `T_BLOB_STORE_ID`,
 * `T_STORE_ID`, `TBLOB_WEBHOOK_PUBLIC_KEY`, `TBLOB_READ_WRITE_TOKEN`, etc.).
 */
export type BlobStoreConfig =
  | {
      ok: true;
      token: string | null;
      storeId: string | null;
      oidcToken: string | null;
      authMode: "token" | "oidc";
      webhookPublicKey?: string | null;
    }
  | {
      ok: false;
      token: null;
      storeId: string | null;
      oidcToken: string | null;
      authMode: "none";
      error: string;
      webhookPublicKey?: string | null;
    };

const BLOB_TOKEN_MISSING =
  "Vercel Blob Private Store is not connected. Attach a Blob store to this Vercel project so BLOB_READ_WRITE_TOKEN is injected, or set BLOB_STORE_ID and enable Vercel OIDC (VERCEL_OIDC_TOKEN). Do not enter a fake storage URL.";

const BLOB_STORE_ID_MISSING =
  "Vercel OIDC is present but BLOB_STORE_ID is missing. Set BLOB_STORE_ID to the private Blob store id, or attach the Blob store so BLOB_READ_WRITE_TOKEN is injected.";

/**
 * Searches environment variables for a key matching exact names or pattern,
 * with an optional fallback based on value heuristics.
 */
function findEnvValue(
  exactNames: string[],
  pattern: RegExp,
  valuePredicate?: (val: string) => boolean,
): string | null {
  for (const name of exactNames) {
    const val = process.env[name];
    if (typeof val === "string" && val.trim() !== "") {
      return val.trim();
    }
  }

  for (const [key, val] of Object.entries(process.env)) {
    if (typeof val !== "string" || !val.trim()) continue;
    if (pattern.test(key)) {
      return val.trim();
    }
  }

  if (valuePredicate) {
    for (const [, val] of Object.entries(process.env)) {
      if (typeof val !== "string" || !val.trim()) continue;
      const trimmed = val.trim();
      if (valuePredicate(trimmed)) {
        return trimmed;
      }
    }
  }

  return null;
}

function findBlobToken(): string | null {
  return findEnvValue(
    ["BLOB_READ_WRITE_TOKEN", "BLOB_TOKEN"],
    /(?:^|_)BLOB_READ_WRITE_TOKEN$|^(?:.*_)?READ_WRITE_TOKEN$|^(?:.*_)?BLOB_TOKEN$/i,
    (val) => val.startsWith("vercel_blob_rw_"),
  );
}

function findBlobStoreId(): string | null {
  return findEnvValue(
    ["BLOB_STORE_ID", "BLOB_ID"],
    /(?:^|_)BLOB_STORE_ID$|^(?:.*_)?STORE_ID$|^(?:.*_)?BLOB_ID$/i,
    (val) => val.startsWith("store_"),
  );
}

function findBlobWebhookPublicKey(): string | null {
  return findEnvValue(
    ["BLOB_WEBHOOK_PUBLIC_KEY", "BLOB_WEBHOOK_KEY"],
    /(?:^|_)BLOB_WEBHOOK_PUBLIC_KEY$|^(?:.*_)?WEBHOOK_PUBLIC_KEY$|^(?:.*_)?BLOB_WEBHOOK_KEY$/i,
  );
}

function findOidcToken(): string | null {
  return findEnvValue(
    ["VERCEL_OIDC_TOKEN", "OIDC_TOKEN"],
    /(?:^|_)VERCEL_OIDC_TOKEN$|^(?:.*_)?OIDC_TOKEN$/i,
  );
}

function parseStoreIdFromToken(token: string): string | null {
  const parts = token.split("_");
  if (parts.length >= 4 && parts[0] === "vercel" && parts[1] === "blob" && parts[2] === "rw") {
    return parts[3] || null;
  }
  return null;
}

/** Inspect Blob credentials without throwing (used by health probes). */
export function readBlobStoreConfig(): BlobStoreConfig {
  const token = findBlobToken();
  const rawStoreId = findBlobStoreId();
  const oidcToken = findOidcToken();
  const webhookPublicKey = findBlobWebhookPublicKey();

  const storeId = rawStoreId ?? (token ? parseStoreIdFromToken(token) : null);

  // Normalize standard env variables so downstream packages / SDKs find them seamlessly
  if (token && !process.env.BLOB_READ_WRITE_TOKEN) {
    process.env.BLOB_READ_WRITE_TOKEN = token;
  }
  if (storeId && !process.env.BLOB_STORE_ID) {
    process.env.BLOB_STORE_ID = storeId;
  }
  if (webhookPublicKey && !process.env.BLOB_WEBHOOK_PUBLIC_KEY) {
    process.env.BLOB_WEBHOOK_PUBLIC_KEY = webhookPublicKey;
  }

  if (token) {
    return {
      ok: true,
      token,
      storeId,
      oidcToken,
      authMode: "token",
      webhookPublicKey,
    };
  }

  if (storeId) {
    return {
      ok: true,
      token: null,
      storeId,
      oidcToken,
      authMode: "oidc",
      webhookPublicKey,
    };
  }

  if (oidcToken && !storeId) {
    return {
      ok: false,
      token: null,
      storeId: null,
      oidcToken,
      authMode: "none",
      error: BLOB_STORE_ID_MISSING,
      webhookPublicKey,
    };
  }

  return {
    ok: false,
    token: null,
    storeId: null,
    oidcToken: null,
    authMode: "none",
    error: BLOB_TOKEN_MISSING,
    webhookPublicKey,
  };
}

/**
 * Vercel Private Blob store configuration (server only).
 *
 * When the Vercel Blob integration is attached, `BLOB_READ_WRITE_TOKEN` is
 * injected automatically. On Vercel runtimes without an explicit token, the
 * SDK authenticates with OIDC (`VERCEL_OIDC_TOKEN` + `BLOB_STORE_ID`).
 */
export function getBlobStoreConfig(): {
  token: string | null;
  storeId: string | null;
  oidcToken: string | null;
  webhookPublicKey?: string | null;
} {
  const config = readBlobStoreConfig();
  if (!config.ok) {
    return configurationError("blob", [config.error], config.error);
  }
  return {
    token: config.token,
    storeId: config.storeId,
    oidcToken: config.oidcToken,
    webhookPublicKey: config.webhookPublicKey,
  };
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
