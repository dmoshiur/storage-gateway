import "server-only";

export interface ObjectMetadata {
  contentLength?: number;
  contentType?: string;
  etag?: string;
  lastModified?: Date;
  metadata?: Record<string, string>;
}

export interface UploadObjectInput {
  key: string;
  body: Uint8Array | ReadableStream | NodeJS.ReadableStream;
  contentType: "application/pdf";
  contentLength?: number;
  metadata?: Record<string, string>;
}

export interface SignedDownloadOptions {
  expiresInSeconds: number;
  disposition: "inline" | "attachment";
  filename: string;
}

export interface SignedUploadOptions {
  expiresInSeconds: number;
  contentLength: number;
  metadata: Record<string, string>;
}

/** Provider-neutral boundary for all object-store access. */
export interface StorageService {
  upload(input: UploadObjectInput): Promise<void>;
  download(key: string, range?: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  /** Optional source ETag makes staging-to-final publication conditional and race-safe. */
  copy(sourceKey: string, destinationKey: string, sourceEtag?: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  getMetadata(key: string): Promise<ObjectMetadata>;
  getSignedUrl(key: string, options: SignedDownloadOptions): Promise<string>;
  getSignedUploadUrl(key: string, options: SignedUploadOptions): Promise<string>;
}
