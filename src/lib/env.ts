import "server-only";

import { timingSafeEqual } from "node:crypto";
import { ApiError } from "@/lib/api/errors";

export type BlobEnvSources = {
  token?: string;
  storeId?: string;
  oidcToken?: string;
  webhookPublicKey?: string;
};

export type BlobStoreConfig =
  | { ok: true; token: string | null; storeId: string | null; oidcToken: string | null; authMode: "token" | "oidc"; webhookPublicKey: string | null; sources: BlobEnvSources }
  | { ok: false; token: null; storeId: string | null; oidcToken: string | null; authMode: "none"; webhookPublicKey: string | null; error: string; sources: BlobEnvSources };

const BLOB_MISSING = "Vercel Private Blob is not configured. Attach a private Blob store or set BLOB_READ_WRITE_TOKEN.";

function requiredSecret(name: string, minimumLength = 24): string {
  const value = process.env[name]?.trim();
  if (!value || value.length < minimumLength) {
    throw new ApiError(503, "SERVICE_CONFIGURATION_ERROR", `${name} is not configured. Set a high-entropy server secret and redeploy.`);
  }
  return value;
}

function nonEmpty(name: string): string | null {
  const value = process.env[name]?.trim();
  return value || null;
}

/** Read only the official Vercel Blob variables. No unrelated cloud credentials are inferred. */
export function readBlobStoreConfig(): BlobStoreConfig {
  const token = nonEmpty("BLOB_READ_WRITE_TOKEN");
  const storeId = nonEmpty("BLOB_STORE_ID");
  const oidcToken = nonEmpty("VERCEL_OIDC_TOKEN");
  const webhookPublicKey = nonEmpty("BLOB_WEBHOOK_PUBLIC_KEY");
  const sources: BlobEnvSources = {
    ...(token ? { token: "BLOB_READ_WRITE_TOKEN" } : {}),
    ...(storeId ? { storeId: "BLOB_STORE_ID" } : {}),
    ...(oidcToken ? { oidcToken: "VERCEL_OIDC_TOKEN" } : {}),
    ...(webhookPublicKey ? { webhookPublicKey: "BLOB_WEBHOOK_PUBLIC_KEY" } : {}),
  };
  if (token) return { ok: true, token, storeId, oidcToken, authMode: "token", webhookPublicKey, sources };
  if (storeId && oidcToken) return { ok: true, token: null, storeId, oidcToken, authMode: "oidc", webhookPublicKey, sources };
  return { ok: false, token: null, storeId, oidcToken, authMode: "none", webhookPublicKey, error: BLOB_MISSING, sources };
}

export function getBlobStoreConfig(): { token: string | null; storeId: string | null; oidcToken: string | null; webhookPublicKey: string | null } {
  const config = readBlobStoreConfig();
  if (!config.ok) throw new ApiError(503, "BLOB_NOT_CONFIGURED", config.error);
  return { token: config.token, storeId: config.storeId, oidcToken: config.oidcToken, webhookPublicKey: config.webhookPublicKey };
}

export function getRequiredSecret(name: "CRON_SECRET"): string {
  return requiredSecret(name);
}

export function constantTimeSecretEquals(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
