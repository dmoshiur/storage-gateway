import "server-only";

import {
  BlobAccessError,
  BlobNotFoundError,
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
import { getBlobStoreConfig, readBlobStoreConfig } from "@/lib/env";
import type {
  ObjectMetadata,
  SignedDownloadOptions,
  SignedUploadOptions,
  StorageHealth,
  StorageService,
  UploadObjectInput,
} from "@/lib/storage/storage-service";

/**
 * Vercel Private Blob storage adapter.
 *
 * This is the ONLY object-storage implementation in the platform. Every PDF is
 * stored in a private Blob store; browsers and API consumers never receive a
 * permanent Blob URL. Temporary, single-operation, single-path signed URLs are
 * minted server-side only after Firebase Auth + Firestore authorization.
 *
 * Authentication (handled automatically by the SDK, in priority order):
 *  1. `BLOB_READ_WRITE_TOKEN` (Vercel Blob integration / dashboard token)
 *  2. Vercel OIDC (`VERCEL_OIDC_TOKEN` + `BLOB_STORE_ID`) on Vercel runtimes
 */

const PRIVATE_ACCESS = "private" as const;

function blobOptions(): { token?: string; storeId?: string; oidcToken?: string } {
  const { token, storeId, oidcToken } = getBlobStoreConfig();
  return {
    ...(token ? { token } : {}),
    ...(storeId ? { storeId } : {}),
    ...(oidcToken && !token ? { oidcToken } : {}),
  };
}

function isNotFound(error: unknown): boolean {
  return error instanceof BlobNotFoundError;
}

function isAccessError(error: unknown): boolean {
  return error instanceof BlobAccessError;
}

function toApiError(error: unknown, fallback: string): ApiError {
  if (error instanceof ApiError) return error;
  if (isNotFound(error)) return new ApiError(404, "BLOB_NOT_FOUND", "The stored object no longer exists.");
  const detail = error instanceof Error && error.message ? ` ${error.message}` : "";
  if (isAccessError(error)) {
    return new ApiError(
      503,
      "BLOB_ACCESS_ERROR",
      `Vercel Blob rejected the request.${detail} Attach a private Blob store to this Vercel project (BLOB_READ_WRITE_TOKEN or OIDC + BLOB_STORE_ID).`,
    );
  }
  return new ApiError(502, "BLOB_REQUEST_FAILED", `${fallback}${detail}`);
}

/** Resolve the canonical Blob URL for a pathname (exact match only). */
async function resolveBlobUrl(pathname: string): Promise<string | null> {
  const options = blobOptions();
  const result = await blobList({ ...options, prefix: pathname, limit: 10 });
  const exact = result.blobs.find((blob) => blob.pathname === pathname) ?? null;
  return exact?.url ?? null;
}

export class VercelBlobStorageService implements StorageService {
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
    try {
      const url = await this.requireUrl(pathname);
      // Use the SDK's private read path rather than fetching the canonical URL
      // manually. This keeps token and Vercel OIDC authentication working in
      // both local and deployed environments and preserves range validation.
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
      return new Uint8Array(await new Response(result.stream).arrayBuffer());
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

  async healthCheck(): Promise<StorageHealth> {
    const startedAt = Date.now();
    const checkedAt = new Date().toISOString();
    const config = readBlobStoreConfig();
    if (!config.ok) {
      return {
        reachable: false,
        latencyMs: Date.now() - startedAt,
        checkedAt,
        error: config.error,
        authMode: "none",
      };
    }
    try {
      await blobList({ ...blobOptions(), limit: 1 });
      return {
        reachable: true,
        latencyMs: Date.now() - startedAt,
        checkedAt,
        error: null,
        authMode: config.authMode,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Blob list probe failed.";
      return {
        reachable: false,
        latencyMs: Date.now() - startedAt,
        checkedAt,
        error: `Vercel Blob store probe failed: ${detail}`,
        authMode: config.authMode,
      };
    }
  }

  private async requireUrl(pathname: string): Promise<string> {
    const url = await resolveBlobUrl(pathname);
    if (!url) throw new ApiError(404, "BLOB_NOT_FOUND", "The stored object no longer exists.");
    return url;
  }
}
