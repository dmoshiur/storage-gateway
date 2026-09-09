import "server-only";

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getR2Env } from "@/lib/env";
import type { ObjectMetadata, SignedDownloadOptions, SignedUploadOptions, StorageHealth, StorageService, UploadObjectInput } from "@/lib/storage/storage-service";

function safeFilename(filename: string): string {
  return filename
    .replace(/[\r\n"\\]/g, "_")
    .replace(/[^\x20-\x7E]/g, "_")
    .slice(0, 140) || "document.pdf";
}

export class R2StorageService implements StorageService {
  private client: S3Client | undefined;

  private getClient(): S3Client {
    if (this.client) return this.client;
    const env = getR2Env();
    this.client = new S3Client({
      region: "auto",
      endpoint: env.R2_ENDPOINT,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });
    return this.client;
  }

  private bucket(): string {
    return getR2Env().R2_BUCKET_NAME;
  }

  async upload(input: UploadObjectInput): Promise<void> {
    await this.getClient().send(new PutObjectCommand({
      Bucket: this.bucket(),
      Key: input.key,
      Body: input.body as never,
      ContentType: input.contentType,
      ContentLength: input.contentLength,
      Metadata: input.metadata,
    }));
  }

  async download(key: string, range?: string): Promise<Uint8Array> {
    const response = await this.getClient().send(new GetObjectCommand({
      Bucket: this.bucket(),
      Key: key,
      ...(range ? { Range: range } : {}),
    }));
    if (!response.Body) throw new Error("Storage returned an empty object body.");
    return response.Body.transformToByteArray();
  }

  async delete(key: string): Promise<void> {
    await this.getClient().send(new DeleteObjectCommand({ Bucket: this.bucket(), Key: key }));
  }

  async copy(sourceKey: string, destinationKey: string, sourceEtag?: string): Promise<void> {
    const encodedKey = encodeURIComponent(sourceKey).replace(/%2F/g, "/");
    await this.getClient().send(new CopyObjectCommand({
      Bucket: this.bucket(),
      Key: destinationKey,
      CopySource: `/${this.bucket()}/${encodedKey}`,
      ...(sourceEtag ? { CopySourceIfMatch: sourceEtag } : {}),
    }));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.getClient().send(new HeadObjectCommand({ Bucket: this.bucket(), Key: key }));
      return true;
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (error as { name?: string }).name === "NotFound") return false;
      throw error;
    }
  }

  async getMetadata(key: string): Promise<ObjectMetadata> {
    const response = await this.getClient().send(new HeadObjectCommand({ Bucket: this.bucket(), Key: key }));
    return {
      contentLength: response.ContentLength,
      contentType: response.ContentType,
      etag: response.ETag,
      lastModified: response.LastModified,
      metadata: response.Metadata,
    };
  }

  async getSignedUrl(key: string, options: SignedDownloadOptions): Promise<string> {
    const filename = safeFilename(options.filename);
    return getSignedUrl(this.getClient(), new GetObjectCommand({
      Bucket: this.bucket(),
      Key: key,
      ResponseContentType: "application/pdf",
      ResponseContentDisposition: `${options.disposition}; filename="${filename}"`,
    }), { expiresIn: options.expiresInSeconds });
  }

  async getSignedUploadUrl(key: string, options: SignedUploadOptions): Promise<string> {
    return getSignedUrl(this.getClient(), new PutObjectCommand({
      Bucket: this.bucket(),
      Key: key,
      ContentType: "application/pdf",
      ContentLength: options.contentLength,
      Metadata: options.metadata,
    }), { expiresIn: options.expiresInSeconds });
  }

  /**
   * Initial bucket connectivity check (HeadBucket) used by the dashboard.
   * Wrapped so that missing R2 credentials, network failures, or timeouts can
   * never crash the UI: callers receive `reachable: false` instead.
   */
  async healthCheck(): Promise<StorageHealth> {
    const startedAt = Date.now();
    const checkedAt = new Date().toISOString();
    try {
      // Hard 3 second socket timeout so a hung network can never stall the
      // dashboard; a bounded send option instead of the shared client config.
      await this.getClient().send(new HeadBucketCommand({ Bucket: this.bucket() }), { requestTimeout: 3000 });
      return { reachable: true, latencyMs: Date.now() - startedAt, checkedAt };
    } catch {
      return { reachable: false, latencyMs: Date.now() - startedAt, checkedAt };
    }
  }
}
