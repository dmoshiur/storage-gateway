import "server-only";

import { timingSafeEqual } from "node:crypto";
import { ApiError } from "@/lib/api/errors";

/* -------------------------------------------------------------------------- */
/* Vercel Private Blob configuration                                          */
/* -------------------------------------------------------------------------- */

/**
 * How the deployment authenticates to Vercel Blob.
 *
 * - `token`: a static `BLOB_READ_WRITE_TOKEN` is present (legacy / non-Vercel).
 * - `oidc` : `BLOB_STORE_ID` is present and the credential is the short-lived
 *            Vercel OIDC token that Vercel issues to the deployment.
 * - `none` : no usable credential is configured; operations must fail with an
 *            exact description of what is missing instead of a generic
 *            "unavailable" message.
 */
export type BlobAuthMode = "token" | "oidc" | "none";

export interface BlobEnvVariableStatus {
  name: string;
  /** True when the variable is present and non-empty in this process. */
  present: boolean;
  /** True when the Blob integration cannot work at all without it. */
  required: boolean;
  role: "credential" | "store-identifier" | "webhook-verification";
  /** Where Vercel/the operator is expected to provide the value. */
  source: "stored-env" | "runtime-request-header" | "stored-env-or-runtime";
  guidance: string;
}

export interface BlobStoreConfiguration {
  ok: boolean;
  authMode: BlobAuthMode;
  /** Server-only static credential. Never log or serialize this value. */
  token: string | null;
  /** Blob store identifier (`store_…` or bare id). Safe to display. */
  storeId: string | null;
  storeIdSource: "BLOB_STORE_ID" | "BLOB_READ_WRITE_TOKEN" | null;
  webhookPublicKey: string | null;
  /**
   * Whether a static `VERCEL_OIDC_TOKEN` happens to be in `process.env`.
   * This is informational only: on Vercel Functions the OIDC token is NOT a
   * stored environment variable. Vercel delivers it per request on the
   * `x-vercel-oidc-token` header, and `@vercel/blob` resolves and refreshes it
   * through `@vercel/oidc`. Requiring it in `process.env` is what broke
   * OIDC-only deployments.
   */
  oidcTokenInEnv: boolean;
  /** True when the code is executing on a Vercel deployment. */
  onVercel: boolean;
  /** Vercel-provided environment name when available (`production`, …). */
  vercelEnv: string | null;
  /** Exact environment variable names that must be set, empty when usable. */
  missing: string[];
  /** Non-fatal configuration problems worth surfacing to the operator. */
  warnings: string[];
  variables: BlobEnvVariableStatus[];
  /** Exact, actionable error message when `ok` is false. */
  error: string | null;
}

/** Message used whenever the store cannot be reached because of missing config. */
const BLOB_NOT_CONFIGURED_MESSAGE =
  "Vercel Private Blob is not configured for this deployment. Missing: BLOB_STORE_ID (required for Vercel OIDC) or BLOB_READ_WRITE_TOKEN (static credential). Connect a private Blob store to this Vercel project (Vercel → Storage → your store → Projects → Connect) so Vercel adds BLOB_STORE_ID and BLOB_WEBHOOK_PUBLIC_KEY, then redeploy. Do not add a mock or local filesystem fallback.";

function nonEmpty(name: string): string | null {
  const value = process.env[name]?.trim();
  return value || null;
}

function requiredSecret(name: string, minimumLength = 24): string {
  const value = process.env[name]?.trim();
  if (!value || value.length < minimumLength) {
    throw new ApiError(503, "SERVICE_CONFIGURATION_ERROR", `${name} is not configured. Set a high-entropy server secret and redeploy.`);
  }
  return value;
}

/** Derives the store id from a static read-write token (same rule as the SDK). */
function storeIdFromReadWriteToken(token: string): string | null {
  const parts = token.split("_");
  const storeId = parts[3]?.trim();
  return storeId ? storeId : null;
}

function variableReport(input: {
  name: string;
  present: boolean;
  required: boolean;
  role: BlobEnvVariableStatus["role"];
  source: BlobEnvVariableStatus["source"];
  guidance: string;
}): BlobEnvVariableStatus {
  return {
    name: input.name,
    present: input.present,
    required: input.required,
    role: input.role,
    source: input.source,
    guidance: input.guidance,
  };
}

/**
 * Reads the official Vercel Blob variables and resolves the authentication
 * mode. No unrelated cloud credentials are inferred, and no value other than
 * the store id is ever returned in a serializable form.
 *
 * Resolution order matches `@vercel/blob`:
 *  1. `BLOB_READ_WRITE_TOKEN` (static credential, wins when present)
 *  2. `BLOB_STORE_ID` + Vercel OIDC (token resolved per request by the SDK)
 */
export function readBlobStoreConfig(): BlobStoreConfiguration {
  const token = nonEmpty("BLOB_READ_WRITE_TOKEN");
  const storeIdEnv = nonEmpty("BLOB_STORE_ID");
  const oidcTokenInEnv = Boolean(nonEmpty("VERCEL_OIDC_TOKEN"));
  const webhookPublicKey = nonEmpty("BLOB_WEBHOOK_PUBLIC_KEY") ?? nonEmpty("BLOB_WEBHOOK_KEY");
  const onVercel = process.env.VERCEL === "1";
  const vercelEnv = nonEmpty("VERCEL_ENV");

  const storeId = storeIdEnv ?? (token ? storeIdFromReadWriteToken(token) : null);
  const storeIdSource: BlobStoreConfiguration["storeIdSource"] = storeIdEnv
    ? "BLOB_STORE_ID"
    : token && storeId
      ? "BLOB_READ_WRITE_TOKEN"
      : null;

  const variables: BlobEnvVariableStatus[] = [
    variableReport({
      name: "BLOB_STORE_ID",
      present: Boolean(storeIdEnv),
      required: !token,
      role: "store-identifier",
      source: "stored-env",
      guidance:
        "Added automatically by Vercel when a Blob store is connected to this project (Vercel → Storage → <store> → Projects → Connect). Required for OIDC authentication.",
    }),
    variableReport({
      name: "BLOB_READ_WRITE_TOKEN",
      present: Boolean(token),
      required: !storeIdEnv,
      role: "credential",
      source: "stored-env",
      guidance:
        "Optional static fallback credential. Vercel only injects it when the store still issues long-lived tokens; OIDC-only stores work without it.",
    }),
    variableReport({
      name: "BLOB_WEBHOOK_PUBLIC_KEY",
      present: Boolean(webhookPublicKey),
      required: false,
      role: "webhook-verification",
      source: "stored-env",
      guidance:
        "Added automatically by Vercel alongside BLOB_STORE_ID. Required by handleUploadPresigned for presigned (direct browser) uploads.",
    }),
    variableReport({
      name: "VERCEL_OIDC_TOKEN",
      present: oidcTokenInEnv,
      required: false,
      role: "credential",
      source: "runtime-request-header",
      guidance:
        "Issued by Vercel per request on the x-vercel-oidc-token header for Functions and refreshed by the SDK. NOT a stored environment variable on Vercel; only `vercel env pull` writes it locally.",
    }),
  ];

  const missing: string[] = [];
  if (!token && !storeIdEnv) {
    missing.push("BLOB_STORE_ID", "BLOB_READ_WRITE_TOKEN");
  }

  const warnings: string[] = [];
  if (storeIdEnv && oidcTokenInEnv && onVercel) {
    warnings.push(
      "A stored VERCEL_OIDC_TOKEN was found in this environment. On Vercel the token is delivered per request and expires (about 2 hours); a stored copy is not refreshed by the platform and will start failing with 403. Remove VERCEL_OIDC_TOKEN from the project's environment variables — BLOB_STORE_ID is sufficient.",
    );
  }
  if (storeIdEnv && !onVercel && !oidcTokenInEnv && !token) {
    warnings.push(
      "BLOB_STORE_ID is set but no OIDC token is available in this process. On Vercel the token arrives per request; outside Vercel run `vercel env pull` to write a short-lived VERCEL_OIDC_TOKEN into .env.local, or set BLOB_READ_WRITE_TOKEN.",
    );
  }
  if (storeIdEnv && !webhookPublicKey) {
    warnings.push(
      "BLOB_WEBHOOK_PUBLIC_KEY is missing. Direct (presigned) browser uploads through /api/blob/upload require it to verify upload-completion callbacks; reconnect the Blob store to this project to restore it.",
    );
  }

  if (!token && !storeIdEnv) {
    return {
      ok: false,
      authMode: "none",
      token: null,
      storeId: null,
      storeIdSource: null,
      webhookPublicKey,
      oidcTokenInEnv,
      onVercel,
      vercelEnv,
      missing,
      warnings,
      variables,
      error: BLOB_NOT_CONFIGURED_MESSAGE,
    };
  }

  return {
    ok: true,
    authMode: token ? "token" : "oidc",
    token,
    storeId,
    storeIdSource,
    webhookPublicKey,
    oidcTokenInEnv,
    onVercel,
    vercelEnv,
    missing,
    warnings,
    variables,
    error: null,
  };
}

/** Configuration object safe to serialize into an admin-only API response. */
export function describeBlobStoreConfiguration(): Omit<BlobStoreConfiguration, "token" | "webhookPublicKey"> & {
  hasReadWriteToken: boolean;
  hasWebhookPublicKey: boolean;
} {
  const config = readBlobStoreConfig();
  const { token, webhookPublicKey, ...rest } = config;
  return {
    ...rest,
    hasReadWriteToken: Boolean(token),
    hasWebhookPublicKey: Boolean(webhookPublicKey),
  };
}

/**
 * Options handed to `@vercel/blob`.
 *
 * The OIDC token is deliberately NOT passed through: `@vercel/oidc` resolves it
 * from the `x-vercel-oidc-token` request header (Vercel Functions) or
 * `process.env.VERCEL_OIDC_TOKEN` (local `vercel env pull`) and refreshes it
 * when it expires. Passing a token read from the environment disables that
 * refresh and makes requests fail with 403 once the token expires.
 */
export function blobSdkAuthOptions(config: BlobStoreConfiguration = readBlobStoreConfig()): {
  token?: string;
  storeId?: string;
} {
  if (!config.ok) return {};
  return {
    ...(config.token ? { token: config.token } : {}),
    // Always pass the store id explicitly so OIDC works even when the SDK's
    // env lookup is unavailable (e.g. bundlers that do not inline process.env).
    ...(config.storeId ? { storeId: config.storeId } : {}),
  };
}

export function getBlobStoreConfig(): {
  authMode: BlobAuthMode;
  token: string | null;
  storeId: string | null;
  webhookPublicKey: string | null;
} {
  const config = readBlobStoreConfig();
  if (!config.ok) {
    throw new ApiError(503, "BLOB_NOT_CONFIGURED", config.error ?? BLOB_NOT_CONFIGURED_MESSAGE, undefined, {
      missingConfiguration: config.missing.join(", "),
      authMode: "none",
      onVercel: config.onVercel,
    });
  }
  return { authMode: config.authMode, token: config.token, storeId: config.storeId, webhookPublicKey: config.webhookPublicKey };
}

/** The webhook public key is optional on the dashboard flow but required for presigned uploads. */
export function getBlobWebhookPublicKey(): string | null {
  return nonEmpty("BLOB_WEBHOOK_PUBLIC_KEY") ?? nonEmpty("BLOB_WEBHOOK_KEY");
}

export function getRequiredSecret(name: "CRON_SECRET"): string {
  return requiredSecret(name);
}

export function constantTimeSecretEquals(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
