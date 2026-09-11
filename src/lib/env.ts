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
/**
 * Which environment variable each credential was resolved from. Names only —
 * never values — so operators can see which variable won without leaking
 * secrets into logs or health payloads.
 */
export type BlobEnvSources = {
  token?: string;
  storeId?: string;
  oidcToken?: string;
  webhookPublicKey?: string;
};

export type BlobStoreConfig =
  | {
      ok: true;
      token: string | null;
      storeId: string | null;
      oidcToken: string | null;
      authMode: "token" | "oidc";
      webhookPublicKey?: string | null;
      sources?: BlobEnvSources;
    }
  | {
      ok: false;
      token: null;
      storeId: string | null;
      oidcToken: string | null;
      authMode: "none";
      error: string;
      webhookPublicKey?: string | null;
      sources?: BlobEnvSources;
    };

const BLOB_TOKEN_MISSING =
  "Vercel Blob Private Store is not connected. Attach a Blob store to this Vercel project so BLOB_READ_WRITE_TOKEN is injected, or set BLOB_STORE_ID and enable Vercel OIDC (VERCEL_OIDC_TOKEN). Do not enter a fake storage URL.";

const BLOB_STORE_ID_MISSING =
  "Vercel OIDC is present but BLOB_STORE_ID is missing. Set BLOB_STORE_ID to the private Blob store id, or attach the Blob store so BLOB_READ_WRITE_TOKEN is injected.";

/**
 * Resolving Blob credentials from `process.env`.
 *
 * Resolution is driven by an explicit allowlist of variable names, never by a
 * loose "anything that looks similar" scan. A previous implementation matched
 * `^(?:.*_)?STORE_ID$` / `^(?:.*_)?OIDC_TOKEN$` across the whole environment,
 * which silently adopted unrelated variables (an `S3_STORE_ID`, or the
 * `GITHUB_OIDC_TOKEN` GitHub Actions injects) and reported the Blob store as
 * configured with somebody else's credentials. It also picked whichever
 * duplicate came first in `Object.entries` order, so the winner depended on
 * process start-up order and could differ between deploys.
 *
 * Invariants this module must keep:
 *  - Only names below are ever read for Blob configuration.
 *  - Selection is deterministic: canonical name first, then a fixed prefix
 *    order, then remaining `*_BLOB_*` names in sorted key order.
 *  - Nothing outside `BLOB_*` is ever written, overwritten, or deleted.
 */

/** Prefixes accepted on the Blob variable stems, in priority order. */
const BLOB_ENV_PREFIXES = ["", "TBLOB_", "T_BLOB_", "T_"] as const;

/** Canonical stems, in priority order. */
const BLOB_ENV_STEMS = {
  token: ["BLOB_READ_WRITE_TOKEN", "READ_WRITE_TOKEN", "BLOB_TOKEN"],
  storeId: ["BLOB_STORE_ID", "STORE_ID", "BLOB_ID"],
  webhookPublicKey: ["BLOB_WEBHOOK_PUBLIC_KEY", "WEBHOOK_PUBLIC_KEY", "BLOB_WEBHOOK_KEY"],
} as const;

/**
 * Any other name carrying a literal `BLOB` segment and one of this concept's own
 * stems (`VERCEL_BLOB_STORE_ID`, `MYAPP_BLOB_READ_WRITE_TOKEN`). The `BLOB`
 * segment is required, so `S3_STORE_ID` and `AWS_READ_WRITE_TOKEN` are never
 * adopted.
 *
 * The pattern is per concept on purpose: one shared pattern let the token lookup
 * match `BLOB_STORE_ID`, so a store id was handed to the SDK as a credential.
 */
const GENERIC_BLOB_NAMES = {
  token: /^(?:[A-Z0-9][A-Z0-9_]{0,23}_)?BLOB_(READ_WRITE_TOKEN|TOKEN)$/,
  storeId: /^(?:[A-Z0-9][A-Z0-9_]{0,23}_)?BLOB_(STORE_ID|ID)$/,
  webhookPublicKey: /^(?:[A-Z0-9][A-Z0-9_]{0,23}_)?BLOB_(WEBHOOK_PUBLIC_KEY|WEBHOOK_KEY)$/,
} as const;

/** Vercel injects exactly these; no fuzzy variants are accepted for OIDC. */
const OIDC_TOKEN_NAMES = ["VERCEL_OIDC_TOKEN", "OIDC_TOKEN"] as const;

/** Unmistakable shape of a Vercel Blob read-write token. */
const BLOB_TOKEN_VALUE_PREFIX = "vercel_blob_rw_";

interface EnvHit {
  value: string;
  source: string;
}

/** Builds the ordered candidate names for a stem list, de-duplicated. */
function candidateNames(stems: readonly string[]): string[] {
  const names: string[] = [];
  for (const stem of stems) {
    for (const prefix of BLOB_ENV_PREFIXES) {
      const name = `${prefix}${stem}`;
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

function nonEmpty(name: string): string | null {
  const value = process.env[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Sorted so a generic match always resolves to the same variable. */
function sortedEnvKeys(): string[] {
  return Object.keys(process.env).sort();
}

function findEnvValue(names: readonly string[], generic?: RegExp): EnvHit | null {
  for (const name of names) {
    const value = nonEmpty(name);
    if (value) return { value, source: name };
  }
  if (generic) {
    for (const name of sortedEnvKeys()) {
      if (!generic.test(name)) continue;
      const value = nonEmpty(name);
      if (value) return { value, source: name };
    }
  }
  return null;
}

function findBlobToken(): EnvHit | null {
  const named = findEnvValue(candidateNames(BLOB_ENV_STEMS.token), GENERIC_BLOB_NAMES.token);
  if (named) return named;
  // Last resort: a token stored under an unrecognised legacy name. The
  // `vercel_blob_rw_` prefix is specific enough that this cannot collide with
  // an unrelated credential.
  for (const name of sortedEnvKeys()) {
    const value = nonEmpty(name);
    if (value && value.startsWith(BLOB_TOKEN_VALUE_PREFIX)) return { value, source: name };
  }
  return null;
}

function findBlobStoreId(): EnvHit | null {
  return findEnvValue(candidateNames(BLOB_ENV_STEMS.storeId), GENERIC_BLOB_NAMES.storeId);
}

function findBlobWebhookPublicKey(): EnvHit | null {
  return findEnvValue(candidateNames(BLOB_ENV_STEMS.webhookPublicKey), GENERIC_BLOB_NAMES.webhookPublicKey);
}

function findOidcToken(): EnvHit | null {
  return findEnvValue(OIDC_TOKEN_NAMES);
}

function parseStoreIdFromToken(token: string): string | null {
  const parts = token.split("_");
  if (parts.length >= 4 && parts[0] === "vercel" && parts[1] === "blob" && parts[2] === "rw") {
    return parts[3] || null;
  }
  return null;
}

/**
 * Inspect Blob credentials without throwing (used by health probes).
 *
 * Side effect: backfills the three canonical `BLOB_*` names below. This is a
 * compatibility shim for SDK paths that read the environment directly. It is
 * strictly additive — a name is only written when it is currently unset, an
 * existing value is never replaced, no key is ever deleted, and only these
 * three Blob-scoped names are ever touched. Core backend configuration
 * (`FIREBASE_*`, `ADMIN_PASS`, `INTEGRATION_API_KEY`, `CRON_SECRET`,
 * `AM_STORAGE_*`) is never read from or written to here.
 */
export function readBlobStoreConfig(): BlobStoreConfig {
  const tokenHit = findBlobToken();
  const storeIdHit = findBlobStoreId();
  const oidcHit = findOidcToken();
  const webhookKeyHit = findBlobWebhookPublicKey();

  const token = tokenHit?.value ?? null;
  const oidcToken = oidcHit?.value ?? null;
  const webhookPublicKey = webhookKeyHit?.value ?? null;
  const storeId = storeIdHit?.value ?? (token ? parseStoreIdFromToken(token) : null);

  const sources: BlobEnvSources = {
    ...(tokenHit ? { token: tokenHit.source } : {}),
    ...(storeIdHit ? { storeId: storeIdHit.source } : {}),
    ...(oidcHit ? { oidcToken: oidcHit.source } : {}),
    ...(webhookKeyHit ? { webhookPublicKey: webhookKeyHit.source } : {}),
  };

  // Additive only: never overwrite an operator-set value.
  if (token && !process.env.BLOB_READ_WRITE_TOKEN) process.env.BLOB_READ_WRITE_TOKEN = token;
  if (storeId && !process.env.BLOB_STORE_ID) process.env.BLOB_STORE_ID = storeId;
  if (webhookPublicKey && !process.env.BLOB_WEBHOOK_PUBLIC_KEY) {
    process.env.BLOB_WEBHOOK_PUBLIC_KEY = webhookPublicKey;
  }

  if (token) {
    return { ok: true, token, storeId, oidcToken, authMode: "token", webhookPublicKey, sources };
  }

  if (storeId) {
    return { ok: true, token: null, storeId, oidcToken, authMode: "oidc", webhookPublicKey, sources };
  }

  if (oidcToken) {
    return {
      ok: false,
      token: null,
      storeId: null,
      oidcToken,
      authMode: "none",
      error: BLOB_STORE_ID_MISSING,
      webhookPublicKey,
      sources,
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
    sources,
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
