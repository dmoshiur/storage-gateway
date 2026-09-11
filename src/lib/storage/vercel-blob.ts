import "server-only";

import {
  BlobAccessError,
  BlobError,
  BlobNotFoundError,
  BlobStoreNotFoundError,
  BlobStoreSuspendedError,
  copy as blobCopy,
  del as blobDelete,
  get as blobGet,
  getDownloadUrl,
  head as blobHead,
  issueSignedToken,
  list as blobList,
  presignUrl,
  put as blobPut,
} from "@vercel/blob";
import { ApiError } from "@/lib/api/errors";
import { blobSdkAuthOptions, readBlobStoreConfig, type BlobStoreConfiguration } from "@/lib/env";
import { logger } from "@/lib/logging/logger";
import type {
  ObjectMetadata,
  SignedDownloadOptions,
  SignedUploadOptions,
  StorageDeepCheck,
  StorageDeepCheckStep,
  StorageHealth,
  StorageService,
  StorageStream,
  UploadObjectInput,
} from "@/lib/storage/storage-service";

/**
 * Vercel Private Blob storage adapter.
 *
 * This is the ONLY object-storage implementation in the platform. Every PDF is
 * stored in a private Blob store; browsers and API consumers never receive a
 * permanent Blob URL. Temporary, single-operation, single-path signed URLs are
 * minted server-side only after first-party auth + authorization.
 *
 * Authentication is handled by the SDK and resolved on every call:
 *  1. `BLOB_READ_WRITE_TOKEN` (static credential, when the store issues one)
 *  2. `BLOB_STORE_ID` + Vercel OIDC. On Vercel Functions the OIDC token is NOT
 *     an environment variable — Vercel delivers it per request on the
 *     `x-vercel-oidc-token` header and `@vercel/oidc` (used by the SDK)
 *     resolves and refreshes it. `BLOB_STORE_ID` alone is therefore a complete
 *     OIDC configuration, and this adapter must not require
 *     `process.env.VERCEL_OIDC_TOKEN` to exist.
 */

const PRIVATE_ACCESS = "private" as const;
const MAX_ERROR_MESSAGE_CHARS = 400;

/**
 * Builds the options passed to the SDK. The OIDC token is intentionally never
 * passed explicitly so the SDK can read it from the request context and refresh
 * it; see `blobSdkAuthOptions`.
 */
function blobOptions(): { token?: string; storeId?: string } {
  return blobSdkAuthOptions();
}

/**
 * Real SDK error class name (`BlobAccessError`, `BlobNotFoundError`, …).
 *
 * The SDK's error classes never assign `error.name`, and a production Next.js
 * bundle may rename class identifiers, so `instanceof` against the exported
 * classes is the only dependable identification.
 */
function errorNameOf(error: unknown): string {
  if (error instanceof BlobAccessError) return "BlobAccessError";
  if (error instanceof BlobNotFoundError) return "BlobNotFoundError";
  if (error instanceof BlobStoreNotFoundError) return "BlobStoreNotFoundError";
  if (error instanceof BlobStoreSuspendedError) return "BlobStoreSuspendedError";
  if (error instanceof BlobError) {
    const constructorName = error.constructor?.name ?? "";
    // `BlobOidcEnvironmentNotAllowedError` is not exported by the SDK; a
    // non-minified runtime still reports its real name.
    if (constructorName === "BlobOidcEnvironmentNotAllowedError") return constructorName;
    return "BlobError";
  }
  if (error instanceof Error) {
    const constructorName = error.constructor?.name ?? "";
    if (constructorName.length > 3 && /^[A-Z]/.test(constructorName)) return constructorName;
    return "Error";
  }
  return typeof error === "object" && error !== null && "name" in error ? String((error as { name: unknown }).name) : "Error";
}

function errorMessageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error";
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_MESSAGE_CHARS);
}

function isNotFound(error: unknown): boolean {
  return error instanceof BlobNotFoundError;
}

function isAccessError(error: unknown): boolean {
  return error instanceof BlobAccessError;
}

/** Classifies the real SDK failure so callers can act on it. */
function classifyBlobError(error: unknown, config: BlobStoreConfiguration): { code: string; hint: string } {
  const name = errorNameOf(error);
  const rawMessage = errorMessageOf(error);

  // This error class is not exported by the SDK; match it by name.
  if (name === "BlobOidcEnvironmentNotAllowedError" || /OIDC is enabled for this project, but not for the/i.test(rawMessage)) {
    return {
      code: "BLOB_OIDC_ENVIRONMENT_NOT_ALLOWED",
      hint: `The Blob store is connected to a different project or this environment (${config.vercelEnv ?? "unknown"}) is not enabled. Open Vercel → Storage → your Blob store → Projects, select this project, and enable the Production (and Preview) environments, then redeploy.`,
    };
  }

  if (isAccessError(error)) {
    return {
      code: "BLOB_ACCESS_ERROR",
      hint: config.authMode === "oidc"
        ? `Vercel Blob rejected the OIDC credentials for store ${config.storeId ?? "(unknown)"}. Confirm the Blob store is connected to THIS Vercel project and that its environment (${config.vercelEnv ?? "unknown"}) is enabled in Vercel → Storage → <store> → Projects. Also remove any stored VERCEL_OIDC_TOKEN so the runtime header token is used.`
        : "Vercel Blob rejected BLOB_READ_WRITE_TOKEN. Verify the token belongs to the store connected to this project and was not rotated.",
    };
  }
  if (error instanceof BlobStoreNotFoundError) {
    return {
      code: "BLOB_STORE_NOT_FOUND",
      hint: `BLOB_STORE_ID=${config.storeId ?? "(not set)"} does not resolve to a Blob store in this Vercel project/team. Reconnect the store (Vercel → Storage → <store> → Projects → Connect) and redeploy so the variable matches.`,
    };
  }
  if (error instanceof BlobStoreSuspendedError) {
    return {
      code: "BLOB_STORE_SUSPENDED",
      hint: "The Blob store is suspended. Resolve the store status in the Vercel dashboard.",
    };
  }
  if (error instanceof BlobError) {
    const message = errorMessageOf(error);
    if (/no blob credentials found/i.test(message)) {
      return {
        code: "BLOB_NOT_CONFIGURED",
        hint: "No Blob credential was visible to the runtime. Connect the private Blob store to this project so Vercel injects BLOB_STORE_ID + BLOB_WEBHOOK_PUBLIC_KEY (or set BLOB_READ_WRITE_TOKEN).",
      };
    }
    if (/missing webhook public key/i.test(message)) {
      return {
        code: "BLOB_WEBHOOK_KEY_MISSING",
        hint: "BLOB_WEBHOOK_PUBLIC_KEY is required for presigned client uploads. Reconnect the Blob store to this project to restore it.",
      };
    }
    if (/client token/i.test(message)) {
      return {
        code: "BLOB_CLIENT_TOKEN_REJECTED",
        hint: "This operation needs a server credential (OIDC or read-write token), not a browser client token.",
      };
    }
  }
  return {
    code: "BLOB_REQUEST_FAILED",
    hint: "The Vercel Blob API request failed. Check the deployment logs for the full SDK error and retry.",
  };
}

/**
 * Converts a real SDK failure into an API error. The underlying Blob error name
 * and message are always preserved in the message/details — never replaced by a
 * generic "unavailable" string.
 */
function toApiError(error: unknown, fallback: string): ApiError {
  if (error instanceof ApiError) return error;

  const config = readBlobStoreConfig();
  if (error instanceof Error && /no blob credentials found/i.test(error.message)) {
    const configurationError = new ApiError(503, "BLOB_NOT_CONFIGURED", config.error ?? errorMessageOf(error), undefined, {
      missingConfiguration: config.missing.join(", "),
      authMode: config.authMode,
    });
    logger.error("Vercel Blob credentials missing", { authMode: config.authMode, missing: config.missing });
    return configurationError;
  }

  if (!config.ok) {
    logger.error("Vercel Blob operation attempted without configuration", { missing: config.missing });
    return new ApiError(503, "BLOB_NOT_CONFIGURED", config.error ?? fallback, undefined, {
      missingConfiguration: config.missing.join(", "),
      authMode: "none",
    });
  }

  if (isNotFound(error)) return new ApiError(404, "BLOB_NOT_FOUND", "The stored object no longer exists.");

  const classification = classifyBlobError(error, config);
  const name = errorNameOf(error);
  const message = errorMessageOf(error);
  logger.error("Vercel Blob operation failed", {
    errorCode: classification.code,
    errorName: name,
    error: message,
    authMode: config.authMode,
    storeId: config.storeId,
    onVercel: config.onVercel,
  });

  const publicMessage = `${fallback} Real error (${name}): ${message} ${classification.hint}`;

  return new ApiError(502, classification.code, publicMessage, undefined, {
    errorName: name,
    error: message,
    authMode: config.authMode,
    storeId: config.storeId ?? "unknown",
    hint: classification.hint,
    retryable: String(classification.code === "BLOB_REQUEST_FAILED"),
  });
}

/** Resolve the canonical Blob URL for a pathname (exact match only). */
async function resolveBlobUrl(pathname: string): Promise<string | null> {
  const options = blobOptions();
  const result = await blobList({ ...options, prefix: pathname, limit: 100 });
  const exact = result.blobs.find((blob) => blob.pathname === pathname) ?? null;
  return exact?.url ?? null;
}

/** Shared diagnostics payload for health responses. */
function healthBase(config: BlobStoreConfiguration) {
  return {
    configured: config.ok,
    authMode: config.authMode,
    storeId: config.storeId,
    storeIdSource: config.storeIdSource,
    onVercel: config.onVercel,
    vercelEnv: config.vercelEnv,
    hasReadWriteToken: Boolean(config.token),
    hasWebhookPublicKey: Boolean(config.webhookPublicKey),
    missingConfiguration: config.missing,
    warnings: config.warnings,
    variables: config.variables,
  };
}

export class VercelBlobStorageService implements StorageService {
  /** Configuration + real credential probe. Never throws. */
  async healthCheck(): Promise<StorageHealth> {
    const startedAt = Date.now();
    const checkedAt = new Date().toISOString();
    const config = readBlobStoreConfig();
    const base = healthBase(config);

    if (!config.ok) {
      return {
        ...base,
        reachable: false,
        latencyMs: Date.now() - startedAt,
        checkedAt,
        error: config.error,
        errorCode: "BLOB_NOT_CONFIGURED",
        errorName: null,
        hint: `Set ${config.missing.join(" + ")} and redeploy. Vercel injects BLOB_STORE_ID and BLOB_WEBHOOK_PUBLIC_KEY automatically when a private Blob store is connected to this project.`,
      };
    }

    try {
      const result = await blobList({ ...blobOptions(), limit: 1 });
      return {
        ...base,
        reachable: true,
        latencyMs: Date.now() - startedAt,
        checkedAt,
        error: null,
        errorCode: null,
        errorName: null,
        hint: null,
        // Non-secret proof that the credential really listed the store.
        probe: { operation: "list", objectsVisible: result.blobs.length },
      };
    } catch (error) {
      const classification = classifyBlobError(error, config);
      const name = errorNameOf(error);
      const message = errorMessageOf(error);
      logger.error("Vercel Blob store health probe failed", {
        errorCode: classification.code,
        errorName: name,
        error: message,
        authMode: config.authMode,
        storeId: config.storeId,
        missing: config.missing,
      });
      return {
        ...base,
        reachable: false,
        latencyMs: Date.now() - startedAt,
        checkedAt,
        error: `Vercel Blob probe failed (${name}): ${message}`,
        errorCode: classification.code,
        errorName: name,
        hint: classification.hint,
      };
    }
  }

  /**
   * Real write → read → delete round-trip against the private store. Proves the
   * credential can upload, read back, and clean up; used by the admin Blob
   * diagnostics endpoint.
   */
  async deepHealthCheck(): Promise<StorageHealth> {
    const startedAt = Date.now();
    const checkedAt = new Date().toISOString();
    const config = readBlobStoreConfig();
    const base = healthBase(config);

    if (!config.ok) {
      return {
        ...base,
        reachable: false,
        latencyMs: Date.now() - startedAt,
        checkedAt,
        error: config.error,
        errorCode: "BLOB_NOT_CONFIGURED",
        errorName: null,
        hint: `Set ${config.missing.join(" + ")} and redeploy.`,
      };
    }

    const pathname = `health/doctor-${crypto.randomUUID()}.pdf`;
    const steps: StorageDeepCheckStep[] = [];
    let uploadUrl: string | null = null;

    const runStep = async (step: StorageDeepCheckStep["step"], work: () => Promise<void>): Promise<void> => {
      const stepStartedAt = Date.now();
      try {
        await work();
        steps.push({ step, ok: true, latencyMs: Date.now() - stepStartedAt, error: null });
      } catch (error) {
        steps.push({
          step,
          ok: false,
          latencyMs: Date.now() - stepStartedAt,
          error: `${errorNameOf(error)}: ${errorMessageOf(error)}`,
        });
        throw error;
      }
    };

    // A byte-for-byte valid PDF is not required for the probe, but using the
    // real content type exercises the same code path as document uploads.
    const probeBody = Buffer.from("%PDF-1.4\n% blob-health-probe\n%%EOF\n", "utf8");

    try {
      await runStep("put", async () => {
        const blob = await blobPut(pathname, probeBody, {
          ...blobOptions(),
          access: PRIVATE_ACCESS,
          contentType: "application/pdf",
          addRandomSuffix: false,
          allowOverwrite: true,
          cacheControlMaxAge: 60,
        });
        uploadUrl = blob.url;
      });
      await runStep("head", async () => {
        if (!uploadUrl) throw new Error("Blob URL unavailable after put.");
        const head = await blobHead(uploadUrl, blobOptions());
        if (head.size !== probeBody.byteLength) {
          throw new Error(`Stored object size ${head.size} does not match the uploaded ${probeBody.byteLength} bytes.`);
        }
      });
      await runStep("get", async () => {
        if (!uploadUrl) throw new Error("Blob URL unavailable after put.");
        const result = await blobGet(uploadUrl, { ...blobOptions(), access: PRIVATE_ACCESS, useCache: false });
        if (!result?.stream) throw new Error("The private object returned no stream.");
        const bytes = new Uint8Array(await new Response(result.stream).arrayBuffer());
        if (bytes.byteLength !== probeBody.byteLength) {
          throw new Error(`Read back ${bytes.byteLength} bytes, expected ${probeBody.byteLength}.`);
        }
      });
      await runStep("delete", async () => {
        if (!uploadUrl) throw new Error("Blob URL unavailable after put.");
        await blobDelete(uploadUrl, blobOptions());
      });
      return {
        ...base,
        reachable: true,
        latencyMs: Date.now() - startedAt,
        checkedAt,
        error: null,
        errorCode: null,
        errorName: null,
        hint: null,
        deepCheck: { ok: true, pathname, steps, cleanedUp: true } satisfies StorageDeepCheck,
      };
    } catch (error) {
      // Best-effort cleanup: the probe object must never linger in the store.
      let cleanedUp = false;
      if (uploadUrl) {
        try {
          await blobDelete(uploadUrl, blobOptions());
          cleanedUp = true;
        } catch {
          cleanedUp = false;
        }
      }
      const classification = classifyBlobError(error, config);
      const name = errorNameOf(error);
      const message = errorMessageOf(error);
      logger.error("Vercel Blob deep health probe failed", {
        errorCode: classification.code,
        errorName: name,
        error: message,
        failedStep: steps.find((step) => !step.ok)?.step ?? "unknown",
        authMode: config.authMode,
        storeId: config.storeId,
      });
      return {
        ...base,
        reachable: false,
        latencyMs: Date.now() - startedAt,
        checkedAt,
        error: `Vercel Blob deep probe failed at "${steps.find((step) => !step.ok)?.step ?? "unknown"}" (${name}): ${message}`,
        errorCode: classification.code,
        errorName: name,
        hint: classification.hint,
        deepCheck: { ok: false, pathname, steps, cleanedUp } satisfies StorageDeepCheck,
      };
    }
  }

  async upload(input: UploadObjectInput): Promise<{ url: string; pathname: string }> {
    try {
      const blob = await blobPut(input.pathname, input.body as never, {
        ...blobOptions(),
        access: PRIVATE_ACCESS,
        contentType: input.contentType,
        addRandomSuffix: false,
        allowOverwrite: true,
        cacheControlMaxAge: 60,
      });
      return { url: blob.url, pathname: blob.pathname };
    } catch (error) {
      throw toApiError(error, "The upload to Blob storage failed.");
    }
  }

  async download(pathname: string, range?: string): Promise<Uint8Array> {
    const streamed = await this.downloadStream(pathname, range);
    return new Uint8Array(await new Response(streamed.stream).arrayBuffer());
  }

  /**
   * Reads the private object through the SDK's authenticated read path and
   * hands the raw stream back untouched, so the caller can serve it without
   * buffering the whole PDF in memory and without ever exposing a Blob URL.
   */
  async downloadStream(pathname: string, range?: string): Promise<StorageStream> {
    try {
      const url = await this.requireUrl(pathname);
      // Use the SDK's private read path rather than fetching the canonical URL
      // manually. This keeps OIDC/token authentication working in both local
      // and deployed environments and preserves range validation.
      const result = await blobGet(url, {
        ...blobOptions(),
        access: PRIVATE_ACCESS,
        useCache: false,
        ...(range ? { headers: { Range: range } } : {}),
      });
      if (!result) throw new ApiError(404, "BLOB_NOT_FOUND", "The stored object no longer exists.");
      if (result.statusCode === 304 || !result.stream) {
        throw new ApiError(502, "BLOB_REQUEST_FAILED", "The download from Blob storage returned no content.");
      }
      const contentRange = result.headers.get("content-range");
      const contentLengthHeader = result.headers.get("content-length");
      return {
        stream: result.stream,
        // The SDK exposes the upstream headers; use them so a Range request
        // preserves 206, Content-Range, and the partial Content-Length.
        contentLength: contentLengthHeader ? Number(contentLengthHeader) : result.blob?.size ?? null,
        contentType: result.blob?.contentType ?? null,
        contentRange,
        statusCode: contentRange ? 206 : result.statusCode,
      };
    } catch (error) {
      throw toApiError(error, "The download from Blob storage failed.");
    }
  }

  async delete(pathname: string): Promise<void> {
    try {
      const url = await resolveBlobUrl(pathname);
      // Deletion is idempotent: a missing object is already "deleted".
      if (!url) return;
      await blobDelete(url, blobOptions());
    } catch (error) {
      if (isNotFound(error)) return;
      throw toApiError(error, "The deletion from Blob storage failed.");
    }
  }

  async copy(sourcePathname: string, destinationPathname: string): Promise<{ url: string; pathname: string }> {
    try {
      const sourceUrl = await this.requireUrl(sourcePathname);
      const blob = await blobCopy(sourceUrl, destinationPathname, {
        ...blobOptions(),
        access: PRIVATE_ACCESS,
        addRandomSuffix: false,
      });
      return { url: blob.url, pathname: blob.pathname };
    } catch (error) {
      throw toApiError(error, "The copy inside Blob storage failed.");
    }
  }

  async exists(pathname: string): Promise<boolean> {
    try {
      return (await resolveBlobUrl(pathname)) !== null;
    } catch (error) {
      throw toApiError(error, "The Blob storage lookup failed.");
    }
  }

  async getMetadata(pathname: string): Promise<ObjectMetadata> {
    try {
      const url = await this.requireUrl(pathname);
      const head = await blobHead(url, blobOptions());
      return {
        contentLength: head.size,
        contentType: head.contentType,
        etag: head.etag ?? undefined,
        lastModified: head.uploadedAt,
      };
    } catch (error) {
      throw toApiError(error, "The Blob metadata lookup failed.");
    }
  }

  /**
   * Mint a short-lived, single-path `GET` signed URL for preview/download.
   * Callers must authorize the request BEFORE calling this.
   */
  async getSignedUrl(pathname: string, options: SignedDownloadOptions): Promise<string> {
    try {
      const validUntil = Date.now() + options.expiresInSeconds * 1000;
      const signed = await issueSignedToken({
        ...blobOptions(),
        pathname,
        operations: ["get"],
        validUntil,
      });
      const { presignedUrl: url } = await presignUrl(signed, {
        operation: "get",
        pathname,
        access: PRIVATE_ACCESS,
        validUntil,
        useCache: false,
      });
      // Vercel Blob uses this flag to select its download disposition while
      // keeping the object private. The authorization remains the short-lived
      // signed delegation above; no permanent URL is exposed.
      if (options.disposition === "attachment") return getDownloadUrl(url);
      return url;
    } catch (error) {
      throw toApiError(error, "Could not create a temporary download link.");
    }
  }

  /**
   * Mint a short-lived, single-path `PUT` signed URL for direct browser upload.
   * The URL constrains content type and size; metadata is verified on completion.
   */
  async getSignedUploadUrl(pathname: string, options: SignedUploadOptions): Promise<string> {
    try {
      const validUntil = Date.now() + options.expiresInSeconds * 1000;
      const signed = await issueSignedToken({
        ...blobOptions(),
        pathname,
        operations: ["put"],
        validUntil,
        allowedContentTypes: [options.contentType],
        maximumSizeInBytes: options.contentLength,
      });
      const { presignedUrl: url } = await presignUrl(signed, {
        operation: "put",
        pathname,
        access: PRIVATE_ACCESS,
        validUntil,
        allowedContentTypes: [options.contentType],
        maximumSizeInBytes: options.contentLength,
        allowOverwrite: true,
        addRandomSuffix: false,
        cacheControlMaxAge: 60,
      });
      return url;
    } catch (error) {
      throw toApiError(error, "Could not create a temporary upload link.");
    }
  }

  /**
   * Mint a short-lived, single-path `DELETE` signed URL for controlled cleanup.
   * Used by server-side maintenance flows, never handed to browsers directly.
   */
  async getSignedDeleteUrl(pathname: string, expiresInSeconds: number): Promise<string> {
    try {
      const validUntil = Date.now() + expiresInSeconds * 1000;
      const signed = await issueSignedToken({
        ...blobOptions(),
        pathname,
        operations: ["delete"],
        validUntil,
      });
      const { presignedUrl: url } = await presignUrl(signed, {
        operation: "delete",
        pathname,
        access: PRIVATE_ACCESS,
        validUntil,
      });
      return url;
    } catch (error) {
      throw toApiError(error, "Could not create a temporary delete link.");
    }
  }

  private async requireUrl(pathname: string): Promise<string> {
    const url = await resolveBlobUrl(pathname);
    if (!url) throw new ApiError(404, "BLOB_NOT_FOUND", "The stored object no longer exists.");
    return url;
  }
}
