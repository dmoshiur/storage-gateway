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
  /** False when required environment configuration is absent. */
  configured?: boolean;
  latencyMs: number;
  checkedAt: string;
  /**
   * Exact failure reason. Never a bare "unavailable": when configuration is
   * missing this lists the exact environment variables, and when the store
   * rejects the request it carries the real Vercel Blob error name/message.
   */
  error?: string | null;
  /** Machine-readable failure classification, e.g. `BLOB_NOT_CONFIGURED`. */
  errorCode?: string | null;
  /** Original SDK error class name, e.g. `BlobAccessError`. */
  errorName?: string | null;
  /** Operator hint that explains how to fix the failure. */
  hint?: string | null;
  authMode?: "token" | "oidc" | "none";
  /** Blob store id the deployment is configured against (safe to display). */
  storeId?: string | null;
  /** Exact environment variable names that are missing, empty when usable. */
  missingConfiguration?: string[];
  /** Non-fatal configuration problems worth showing to the operator. */
  warnings?: string[];
  /** Per-variable presence report (names and booleans only, never values). */
  variables?: Array<{
    name: string;
    present: boolean;
    required: boolean;
    role: string;
    source: string;
    guidance: string;
  }>;
  /** Non-secret detail about the probe that ran (e.g. list result). */
  probe?: { operation: "list"; objectsVisible: number } | null;
  /** Result of the optional write/read/delete round-trip (`?deep=true`). */
  deepCheck?: StorageDeepCheck | null;
}

export interface StorageDeepCheckStep {
  step: "put" | "head" | "get" | "delete";
  ok: boolean;
  latencyMs: number;
  /** Real error name/message when the step failed. */
  error?: string | null;
}

export interface StorageDeepCheck {
  ok: boolean;
  pathname: string;
  steps: StorageDeepCheckStep[];
  cleanedUp: boolean;
}

/**
 * Provider boundary for all object-store access.
 * Vercel Private Blob is the only implementation (`vercel-blob.ts`).
 */
export interface StorageStream {
  stream: ReadableStream<Uint8Array>;
  contentLength: number | null;
  contentType: string | null;
  contentRange?: string | null;
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
  /**
   * Real round-trip probe: writes a tiny object, reads its metadata and bytes,
   * then deletes it. Proves the credential can actually write to the store.
   */
  deepHealthCheck(): Promise<StorageHealth>;
}
