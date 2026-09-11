import "server-only";

export interface ObjectMetadata {
  contentLength?: number;
  contentType?: string;
  etag?: string;
  lastModified?: Date;
  metadata?: Record<string, string>;
}

export interface UploadObjectInput {
  /** Blob pathname, e.g. `pdfs/2026/09/<uuid>.pdf`. UUID-based, never user input. */
  pathname: string;
  body: Uint8Array | ReadableStream | Blob;
  contentType: string;
  contentLength?: number;
  metadata?: Record<string, string>;
}

export interface UploadObjectResult {
  /** Canonical private Blob URL (server-only, never expose to browsers). */
  url: string;
  pathname: string;
}

export interface SignedDownloadOptions {
  expiresInSeconds: number;
  disposition: "inline" | "attachment";
  filename: string;
  contentType?: string;
}

export interface SignedUploadOptions {
  expiresInSeconds: number;
  contentType: string;
  contentLength: number;
  metadata: Record<string, string>;
}

/** Result of a lightweight store connectivity probe (never throws). */
export interface StorageHealth {
  reachable: boolean;
  latencyMs: number;
  checkedAt: string;
  /** Present when the store is not connected or the probe failed. */
  error?: string | null;
  authMode?: "token" | "oidc" | "none";
}

/**
 * Provider boundary for all object-store access.
 * Vercel Private Blob is the only implementation (`vercel-blob.ts`).
 */
export interface StorageStream {
  stream: ReadableStream<Uint8Array>;
  contentLength: number | null;
  contentType: string | null;
  statusCode: number;
}

export interface StorageService {
  upload(input: UploadObjectInput): Promise<UploadObjectResult>;
  download(pathname: string, range?: string): Promise<Uint8Array>;
  /**
   * Streams the private object straight through the caller without buffering
   * the whole document in the function. Used by the authenticated
   * preview/download routes so browsers never receive a Blob URL at all.
   */
  downloadStream(pathname: string, range?: string): Promise<StorageStream>;
  delete(pathname: string): Promise<void>;
  copy(sourcePathname: string, destinationPathname: string): Promise<UploadObjectResult>;
  exists(pathname: string): Promise<boolean>;
  getMetadata(pathname: string): Promise<ObjectMetadata>;
  /** Short-lived single-path `GET` signed URL (preview / download). */
  getSignedUrl(pathname: string, options: SignedDownloadOptions): Promise<string>;
  /** Short-lived single-path `PUT` signed URL (direct browser upload). */
  getSignedUploadUrl(pathname: string, options: SignedUploadOptions): Promise<string>;
  /** Short-lived single-path `DELETE` signed URL (controlled cleanup). */
  getSignedDeleteUrl(pathname: string, expiresInSeconds: number): Promise<string>;
  /** Store connectivity probe. Resolves (never rejects) so dashboards can always render. */
  healthCheck(): Promise<StorageHealth>;
}
