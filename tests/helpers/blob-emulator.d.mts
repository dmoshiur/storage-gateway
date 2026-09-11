/**
 * Types for the test-only Blob API emulator (`blob-emulator.mjs`).
 * See that file for why it exists; it is never imported by `src/`.
 */
export interface BlobEmulatorRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  bodyLength: number;
  at: string;
}

export interface BlobEmulatorObject {
  bytes: Buffer;
  contentType: string;
  uploadedAt: string;
  etag: string;
}

export interface BlobEmulatorFailure {
  matcher?: (request: BlobEmulatorRequest) => boolean;
  status?: number;
  code?: string;
  message?: string;
}

export interface BlobEmulator {
  port: number;
  storeId: string;
  hostName: string | null;
  apiUrl: string;
  hostFor(pathname: string): string;
  requests: BlobEmulatorRequest[];
  objects: Map<string, BlobEmulatorObject>;
  seed(pathname: string, bytes: Uint8Array, contentType?: string): void;
  failNext(failure: BlobEmulatorFailure): void;
  seen(method: string, pathFragment?: string): BlobEmulatorRequest[];
  close(): Promise<void>;
}

export function createBlobEmulator(options?: {
  port?: number;
  storeId?: string;
  hostName?: string | null;
}): Promise<BlobEmulator>;
