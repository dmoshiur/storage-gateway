import "server-only";

import type { z } from "zod";
import { ApiError, isApiError } from "@/lib/api/errors";
import { success } from "@/lib/api/response";
import { validationError } from "@/lib/api/validation";
import { getClientIp } from "@/lib/security/request-auth";
import { logger } from "@/lib/logging/logger";
import type { ApiRequestContext } from "@/lib/db/api-metrics";
import { enforceRateLimit, enforceDatabaseRateLimit } from "@/lib/security/rate-limit";
import { bridgeLogKeyFromHeaders, hasBridgeCredentialHeaders, requireBridgeCredential, type BridgeCredential } from "@/lib/bridge/auth";
import { DIRECT_UPLOAD_GUIDANCE_BYTES, getBridgeMaxDocumentBytes, getBridgeSignedUrlExpirySeconds } from "@/lib/bridge/config";
import {
  bridgeUploader,
  buildBridgeObjectKey,
  cleanBridgeFilename,
  logBridgeUploadAttempt,
  parseBridgeTags,
} from "@/lib/bridge/upload";
import {
  assertDocumentMetadata,
  assertValidatedBlobDocument,
  inspectDocumentSignature,
  stripDocumentExtension,
} from "@/lib/validation/documents";
import { bridgeUploadCompleteSchema, bridgeUploadInitSchema } from "@/lib/validation/bridge";
import { getSettings } from "@/lib/db/settings";
import { getStorageStats } from "@/lib/db/stats";
import {
  activateUpload,
  clearUploadKey,
  createBridgeFile,
  createUploadingFile,
  markUploadFailed,
  requireFileById,
  serializeFile,
} from "@/lib/db/files";
import { auditActorFrom, writeAuditLogSafely } from "@/lib/db/audit";
import { defaultRetention } from "@/lib/retention";
import { createHash } from "node:crypto";
import { emitWebhookEvent } from "@/lib/webhooks/dispatch";
import { requireScope, type ApiScope } from "@/lib/security/api-keys";
import { bearerTokenFrom, requireBearerScope, verifyBearerKeySafely } from "@/lib/security/bearer-keys";
import { getStorageService } from "@/lib/storage";
import { toServiceFailure } from "@/lib/api/failures";
import type { FileDocument } from "@/types/file";

/** Credential shapes accepted by the direct upload handler. */
type UploadCredential =
  | BridgeCredential
  | { mode: "bearer"; keyId: string; logKey: string };

async function requireUploadCredential(request: Request, requiredScope: ApiScope, requestId: string): Promise<UploadCredential> {
  const requestContext: ApiRequestContext = { method: request.method, path: new URL(request.url).pathname, requestId, ip: getClientIp(request) };

  // Key-id/secret headers take precedence: when a caller sends them explicitly
  // they must be the credential that is validated, never silently ignored in
  // favour of an Authorization header.
  if (hasBridgeCredentialHeaders(request)) {
    const credential = await requireBridgeCredential(request, requestContext);
    // Authorize against the scopes resolved during authentication so a key
    // cannot be revoked-and-reused between the two steps.
    requireScope(credential.scopes, requiredScope);
    return credential;
  }

  const bearer = bearerTokenFrom(request);
  if (bearer) {
    const verified = await verifyBearerKeySafely(bearer, requestContext);
    if (!verified) {
      logger.warn("API key authentication failed", { reason: "bad_bearer_token", method: request.method, path: requestContext.path, requestId, ip: requestContext.ip });
      throw new ApiError(401, "INVALID_API_KEY", "Missing or invalid API credential. Send X-AM-Storage-Key-Id with X-AM-Storage-Key-Secret, or Authorization: Bearer <secret>.");
    }
    requireBearerScope(verified.scopes, requiredScope);
    return { mode: "bearer", keyId: verified.keyId, logKey: verified.keyId };
  }

  logger.warn("API key authentication failed", { reason: "missing_headers", method: request.method, path: requestContext.path, requestId, ip: requestContext.ip });
  throw new ApiError(401, "INVALID_API_KEY", "Missing or invalid API credential. Send X-AM-Storage-Key-Id with X-AM-Storage-Key-Secret, or Authorization: Bearer <secret>.");
}

const VALIDATION_CODES = new Set(["INVALID_FILE_TYPE", "UPLOAD_SIZE_MISMATCH", "UPLOAD_OWNERSHIP_MISMATCH", "INVALID_DOCUMENT"]);
const SNIFF_WINDOW_BYTES = 2048;

const INTEGRATION_AUDIT_ACTOR = { uid: "website-integration", email: null, type: "integration" } as const;

/** Reads a small JSON control payload with declared-length and actual-size caps. */
async function readBoundedJsonBody(request: Request, maxBytes = 64 * 1024): Promise<Uint8Array> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "This endpoint accepts JSON requests only.");
  }
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > maxBytes) {
    throw new ApiError(413, "REQUEST_TOO_LARGE", "This request is too large.");
  }
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength === 0) throw new ApiError(400, "INVALID_JSON", "The request body must be valid JSON.");
  if (raw.byteLength > maxBytes) throw new ApiError(413, "REQUEST_TOO_LARGE", "This request is too large.");
  return raw;
}

function parseBridgeJson<T extends z.ZodTypeAny>(raw: Uint8Array, schema: T): z.infer<T> {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "The request body must be valid JSON.");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw validationError(parsed.error.issues, "body");
  return parsed.data;
}

async function signBridgeDocumentUrl(file: Pick<FileDocument, "storagePath" | "originalName" | "mimeType">): Promise<{ url: string; expiresAt: string }> {
  const expiresInSeconds = getBridgeSignedUrlExpirySeconds();
  const url = await getStorageService().getSignedUrl(file.storagePath, {
    expiresInSeconds,
    disposition: "inline",
    filename: file.originalName,
    contentType: file.mimeType,
  });
  return { url, expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString() };
}

/**
 * POST /api/v1/storage/upload — direct multipart upload for smaller documents.
 *
 * The credential is verified before the body is parsed; every attempt (success
 * or failure) is logged for the dashboard's API Upload Activity widget. Files
 * larger than Vercel's function payload (~4.5 MB) must use the presigned
 * init → PUT → complete flow instead — the platform rejects them before this
 * code runs, so the 413 guidance below only triggers for the configured
 * document cap.
 */
export async function handleBridgeDirectUpload(
  request: Request,
  requestId: string,
  options: { requiredScope?: ApiScope; allowBearer?: boolean } = {},
): Promise<Response> {
  // Rate limiting runs before authentication so unauthenticated floods cannot
  // bypass the per-instance budget by omitting credentials.
  const uploadRateKey = `bridge:upload:${getClientIp(request)}`;
  enforceRateLimit(uploadRateKey, 240);
  await enforceDatabaseRateLimit(uploadRateKey, 240);

  const requestContext: ApiRequestContext = { method: request.method, path: new URL(request.url).pathname, requestId, ip: getClientIp(request) };
  let credential: UploadCredential | null = null;
  let uploaderLabel = "unknown";
  let filename = "unknown";
  try {
    if (options.allowBearer) {
      credential = await requireUploadCredential(request, options.requiredScope ?? "files:upload", requestId);
      uploaderLabel = credential.mode === "bearer" ? `api:${credential.keyId}` : bridgeUploader(credential);
    } else {
      credential = await requireBridgeCredential(request, requestContext);
      if (options.requiredScope) requireScope(credential.scopes, options.requiredScope);
      uploaderLabel = bridgeUploader(credential);
    }

    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("multipart/form-data")) {
      throw new ApiError(400, "VALIDATION_ERROR", "The upload must be sent as multipart/form-data.");
    }
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new ApiError(400, "VALIDATION_ERROR", "The multipart body could not be parsed.");
    }

    const fileValue = form.get("file");
    if (!(fileValue instanceof File)) {
      throw new ApiError(422, "VALIDATION_ERROR", "The multipart form is missing the required 'file' field.");
    }
    const textField = (name: string): string => {
      const value = form.get(name);
      return typeof value === "string" ? value : "";
    };

    filename = cleanBridgeFilename(fileValue.name);
    const size = fileValue.size;
    let settings: Awaited<ReturnType<typeof getSettings>>;
    let stats: Awaited<ReturnType<typeof getStorageStats>>;
    try {
      [settings, stats] = await Promise.all([getSettings(), getStorageStats()]);
    } catch (error) {
      throw toServiceFailure({
        status: 503,
        code: "STORAGE_METADATA_UNAVAILABLE",
        message: "Upload limits could not be read from PostgreSQL. Please retry shortly.",
        cause: error,
        operation: "v1/storage/upload:limits",
        area: "database",
        requestId,
      });
    }
    const effectiveMax = Math.min(settings.maxPdfSizeBytes, getBridgeMaxDocumentBytes());
    const document = assertDocumentMetadata(filename, size, effectiveMax, fileValue.type || undefined);
    if (stats.totalStorageBytes + size > settings.storageLimitBytes) {
      throw new ApiError(409, "STORAGE_LIMIT_EXCEEDED", "Uploading this document would exceed the configured storage limit.");
    }

    const bytes = new Uint8Array(await fileValue.arrayBuffer());
    if (bytes.byteLength !== size) {
      throw new ApiError(400, "UPLOAD_SIZE_MISMATCH", "The uploaded file size could not be verified.");
    }
    const signature = inspectDocumentSignature(
      document.extension,
      bytes.subarray(0, SNIFF_WINDOW_BYTES),
      bytes.subarray(Math.max(0, bytes.byteLength - SNIFF_WINDOW_BYTES)),
    );
    if (!signature.valid) {
      throw new ApiError(400, "INVALID_DOCUMENT", signature.reason ?? "The uploaded file is not a valid document.");
    }

    const storage = getStorageService();
    const objectKey = buildBridgeObjectKey(document.extension);
    try {
      await storage.upload({ pathname: objectKey, body: bytes, contentType: document.mimeType, contentLength: size });
    } catch (error) {
      try { await storage.delete(objectKey); } catch { /* compensation cleanup is best-effort */ }
      if (isApiError(error)) throw error;
      throw new ApiError(502, "BLOB_UPLOAD_FAILED", "The document could not be stored. Please retry shortly.");
    }

    try {
      const metadata = await storage.getMetadata(objectKey);
      if (metadata.contentLength !== size) {
        throw new ApiError(502, "BLOB_UPLOAD_FAILED", "The stored document could not be verified.");
      }
    } catch (error) {
      try { await storage.delete(objectKey); } catch { /* compensation cleanup is best-effort */ }
      if (isApiError(error) && error.code === "BLOB_UPLOAD_FAILED") throw error;
      if (isApiError(error)) throw error;
      throw new ApiError(502, "BLOB_UPLOAD_FAILED", "The stored document could not be verified.");
    }

    // Sign the URL before registration so a registration failure can still
    // remove the orphaned object without leaving a signed URL dangling.
    let signed: { url: string; expiresAt: string };
    try {
      signed = await signBridgeDocumentUrl({ ...({} as FileDocument), storagePath: objectKey, originalName: filename, mimeType: document.mimeType });
    } catch (error) {
      try { await storage.delete(objectKey); } catch { /* compensation cleanup is best-effort */ }
      if (isApiError(error)) throw error;
      throw new ApiError(502, "STORAGE_UNAVAILABLE", "A signed document URL could not be generated. Please retry shortly.");
    }

    let file: FileDocument;
    try {
      file = await createBridgeFile({
        storagePath: objectKey,
        originalName: filename,
        title: textField("title").trim().replace(/\s+/g, " ").slice(0, 160) || stripDocumentExtension(filename),
        description: textField("description").trim().replace(/\s+/g, " ").slice(0, 2000),
        category: textField("category").trim().replace(/\s+/g, " ").slice(0, 80),
        tags: parseBridgeTags(textField("tags") || null),
        mimeType: document.mimeType,
        extension: document.extension,
        size,
        uploadedBy: uploaderLabel,
        contentHash: createHash("sha256").update(bytes).digest("hex"),
        retention: defaultRetention(settings),
      });
    } catch (error) {
      try { await storage.delete(objectKey); } catch { /* never leave an unregistered object behind */ }
      if (isApiError(error)) throw error;
      throw new ApiError(503, "REGISTRATION_FAILED", "The document could not be registered. Please retry shortly.");
    }

    await writeAuditLogSafely({
      action: "BRIDGE_UPLOAD",
      actor: auditActorFrom(INTEGRATION_AUDIT_ACTOR),
      fileId: file.id,
      fileName: file.originalName,
      details: { size: file.size },
      requestId,
    });
    await logBridgeUploadAttempt({ keyId: credential.logKey, filename, sizeBytes: size, status: "success", failureCode: null, requestId });
    emitWebhookEvent("file.uploaded", { fileId: file.id, fileName: file.originalName, size: file.size, via: "api" });

    return success({ file: serializeFile(file), url: signed.url, expiresAt: signed.expiresAt, filename, size }, requestId, 201);
  } catch (error) {
    await logBridgeUploadAttempt({
      keyId: credential?.logKey ?? bridgeLogKeyFromHeaders(request),
      filename,
      sizeBytes: 0,
      status: "failed",
      failureCode: isApiError(error) ? error.code : "INTERNAL_ERROR",
      requestId,
    });
    throw error;
  }
}

/**
 * POST /api/v1/storage/upload/init — step 1 of the presigned flow for larger
 * documents. Mints a short-lived Blob PUT URL; the integration uploads bytes
 * directly to the private Blob store (bypassing Vercel's function payload limit entirely), then
 * calls .../complete.
 */
export async function handleBridgeUploadInit(request: Request, requestId: string): Promise<Response> {
  const uploadInitRateKey = `bridge:upload-init:${getClientIp(request)}`;
  enforceRateLimit(uploadInitRateKey, 120);
  await enforceDatabaseRateLimit(uploadInitRateKey, 120);
  const rawBody = await readBoundedJsonBody(request);
  const credential = await requireUploadCredential(request, "files:upload", requestId);
  const input = parseBridgeJson(rawBody, bridgeUploadInitSchema);

  let settings: Awaited<ReturnType<typeof getSettings>>;
  let stats: Awaited<ReturnType<typeof getStorageStats>>;
  try {
    [settings, stats] = await Promise.all([getSettings(), getStorageStats()]);
  } catch (error) {
    throw toServiceFailure({
      status: 503,
      code: "STORAGE_METADATA_UNAVAILABLE",
      message: "Upload limits could not be read from PostgreSQL. Please retry shortly.",
      cause: error,
      operation: "v1/storage/upload/init:limits",
      area: "database",
      requestId,
    });
  }
  const effectiveMax = Math.min(settings.maxPdfSizeBytes, getBridgeMaxDocumentBytes());
  const document = assertDocumentMetadata(input.originalName, input.size, effectiveMax, input.mimeType || undefined);
  if (stats.totalStorageBytes + stats.pendingUploadBytes + input.size > settings.storageLimitBytes) {
    throw new ApiError(409, "STORAGE_LIMIT_EXCEEDED", "Uploading this document would exceed the configured storage limit.");
  }

  const file = await createUploadingFile({
    storagePath: buildBridgeObjectKey(document.extension),
    uploadKey: null,
    originalName: input.originalName,
    title: input.title || stripDocumentExtension(input.originalName),
    description: input.description,
    category: input.category,
    tags: input.tags,
    mimeType: document.mimeType,
    extension: document.extension,
    size: input.size,
    uploadedBy: credential.mode === "bearer" ? `api:${credential.keyId}` : bridgeUploader(credential),
    retention: defaultRetention(settings),
  });

  try {
    const expiresInSeconds = Math.min(20 * 60, Math.max(5 * 60, settings.signedUrlExpirySeconds));
    // For bridge uploads, storagePath is the final private Blob pathname (pdfs/...).
    // Direct-to-final upload: no staging key, so use storagePath.
    const uploadPath = file.storagePath;
    const uploadUrl = await getStorageService().getSignedUploadUrl(uploadPath, {
      expiresInSeconds,
      contentType: document.mimeType,
      contentLength: file.size,
      metadata: {},
    });
    return success({
      file: serializeFile(file),
      uploadUrl,
      uploadMethod: "PUT",
      uploadHeaders: {
        "Content-Type": document.mimeType,
      },
      directUploadRecommended: input.size <= DIRECT_UPLOAD_GUIDANCE_BYTES,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
    }, requestId, 201);
  } catch (error) {
    await markUploadFailed(file.id, "UPLOAD_URL_GENERATION_FAILED");
    if (isApiError(error)) throw error;
    throw new ApiError(502, "STORAGE_UNAVAILABLE", "A signed upload URL could not be generated. Please retry shortly.");
  }
}

/**
 * POST /api/v1/storage/upload/complete — step 3 of the presigned flow.
 * Verifies the staged Blob object (size, content type, ownership, magic bytes),
 * publishes it to its final key, and returns the signed document URL. Only the
 * credential that started the upload may complete it.
 */
export async function handleBridgeUploadComplete(request: Request, requestId: string): Promise<Response> {
  const uploadCompleteRateKey = `bridge:upload-complete:${getClientIp(request)}`;
  enforceRateLimit(uploadCompleteRateKey, 120);
  await enforceDatabaseRateLimit(uploadCompleteRateKey, 120);
  const rawBody = await readBoundedJsonBody(request);
  const credential = await requireUploadCredential(request, "files:upload", requestId);
  const input = parseBridgeJson(rawBody, bridgeUploadCompleteSchema);
  const expectedUploader = credential.mode === "bearer" ? `api:${credential.keyId}` : bridgeUploader(credential);

  let filename = "unknown";
  try {
    const file = await requireFileById(input.fileId);
    filename = file.originalName;
    if (file.uploadedBy !== expectedUploader) {
      throw new ApiError(403, "FORBIDDEN", "This upload was started by a different API credential.");
    }
    if (file.status === "active") {
      // Idempotent retry: the bytes are already published, so mint a fresh URL.
      const signed = await signBridgeDocumentUrl(file);
      await logBridgeUploadAttempt({ keyId: credential.logKey, filename, sizeBytes: file.size, status: "success", failureCode: null, requestId });
      return success({ file: serializeFile(file), url: signed.url, expiresAt: signed.expiresAt, filename, size: file.size }, requestId);
    }
    if (file.status !== "uploading") {
      throw new ApiError(409, "UPLOAD_NOT_PENDING", "This upload is no longer awaiting completion.");
    }

    const storage = getStorageService();
    const objectPath = file.uploadKey ?? file.storagePath;
    try {
      const [metadata, firstBytes, lastBytes] = await Promise.all([
        storage.getMetadata(objectPath),
        storage.download(objectPath, `bytes=0-${SNIFF_WINDOW_BYTES - 1}`),
        storage.download(objectPath, `bytes=-${SNIFF_WINDOW_BYTES}`),
      ]);
      assertValidatedBlobDocument({
        originalName: file.originalName,
        expectedSize: file.size,
        actualSize: metadata.contentLength,
        contentType: metadata.contentType,
        firstBytes,
        lastBytes,
        objectFileId: metadata.metadata?.["file-id"],
      });
    } catch (error) {
      if (isApiError(error) && VALIDATION_CODES.has(error.code)) {
        try { await storage.delete(objectPath); } catch { /* stale upload cleanup will retry if needed */ }
        await markUploadFailed(file.id, error.code);
        await writeAuditLogSafely({ action: "UPLOAD_FAILED", actor: auditActorFrom(INTEGRATION_AUDIT_ACTOR), fileId: file.id, fileName: file.originalName, details: { reason: error.code }, requestId });
        throw error;
      }
      if (isApiError(error)) throw error;
      throw new ApiError(502, "STORAGE_UNAVAILABLE", "The document could not be verified in storage. Please retry shortly.");
    }

    // Direct-to-final Blob uploads need no copy step: activation is a pure metadata transition.
    if (file.uploadKey) {
      try { await storage.delete(file.uploadKey); } catch { /* safe, retryable staging cleanup */ }
      try { await clearUploadKey(file.id); } catch { /* cleanup retries via cron */ }
    }
    const active = await activateUpload(file.id);
    await writeAuditLogSafely({ action: "BRIDGE_UPLOAD", actor: auditActorFrom(INTEGRATION_AUDIT_ACTOR), fileId: active.id, fileName: active.originalName, details: { size: active.size }, requestId });

    const signed = await signBridgeDocumentUrl(active);
    await logBridgeUploadAttempt({ keyId: credential.logKey, filename, sizeBytes: active.size, status: "success", failureCode: null, requestId });
    emitWebhookEvent("file.uploaded", { fileId: active.id, fileName: active.originalName, size: active.size, via: "api" });
    return success({ file: serializeFile(active), url: signed.url, expiresAt: signed.expiresAt, filename, size: active.size }, requestId);
  } catch (error) {
    await logBridgeUploadAttempt({
      keyId: credential.logKey,
      filename,
      sizeBytes: 0,
      status: "failed",
      failureCode: isApiError(error) ? error.code : "INTERNAL_ERROR",
      requestId,
    });
    throw error;
  }
}
