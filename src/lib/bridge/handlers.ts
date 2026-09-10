import "server-only";

import type { z } from "zod";
import { ApiError, isApiError } from "@/lib/api/errors";
import { success } from "@/lib/api/response";
import { getClientIp } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { bridgeLogKeyFromHeaders, requireBridgeCredential, type BridgeCredential } from "@/lib/bridge/auth";
import { DIRECT_UPLOAD_GUIDANCE_BYTES, getBridgeMaxDocumentBytes, getBridgeSignedUrlExpirySeconds } from "@/lib/bridge/config";
import {
  bridgeUploader,
  buildBridgeObjectKey,
  buildBridgeStagingKey,
  cleanBridgeFilename,
  logBridgeUploadAttempt,
  parseBridgeTags,
} from "@/lib/bridge/upload";
import {
  assertDocumentMetadata,
  assertValidatedR2Document,
  inspectDocumentSignature,
  stripDocumentExtension,
} from "@/lib/validation/documents";
import { bridgeUploadCompleteSchema, bridgeUploadInitSchema } from "@/lib/validation/bridge";
import { getSettings } from "@/lib/firestore/settings";
import { getStorageStats } from "@/lib/firestore/stats";
import {
  activateUpload,
  clearUploadKey,
  createBridgeFile,
  createUploadingFile,
  markUploadFailed,
  requireFileById,
  serializeFile,
} from "@/lib/firestore/files";
import { auditActorFrom, writeAuditLogSafely } from "@/lib/firestore/audit";
import { defaultRetention } from "@/lib/retention";
import { getStorageService } from "@/lib/storage";
import type { FileDocument } from "@/types/file";

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
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) fields[issue.path.join(".") || "body"] = issue.message;
    throw new ApiError(400, "VALIDATION_ERROR", "Some information is missing or invalid.", fields);
  }
  return parsed.data;
}

/** True when HMAC signed headers are the effective credential (raw bytes needed before parsing). */
function isSignedRequest(request: Request): boolean {
  if ((request.headers.get("x-am-storage-key") ?? "").trim()) return false;
  const keyId = (request.headers.get("x-am-storage-key-id") ?? "").trim();
  if ((request.headers.get("x-am-storage-key-secret") ?? "").trim()) return false;
  return Boolean(keyId && (request.headers.get("x-am-storage-signature") ?? "").trim() && (request.headers.get("x-am-storage-timestamp") ?? "").trim());
}

async function signBridgeDocumentUrl(file: Pick<FileDocument, "storageKey" | "originalName" | "mimeType">): Promise<{ url: string; expiresAt: string }> {
  const expiresInSeconds = getBridgeSignedUrlExpirySeconds();
  const url = await getStorageService().getSignedUrl(file.storageKey, {
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
export async function handleBridgeDirectUpload(request: Request, requestId: string): Promise<Response> {
  // Rate limiting runs before authentication so unauthenticated floods cannot
  // bypass the per-instance budget by omitting credentials.
  enforceRateLimit(`bridge:upload:${getClientIp(request)}`, 240);

  let credential: BridgeCredential | null = null;
  let filename = "unknown";
  try {
    const rawBody = isSignedRequest(request) ? new Uint8Array(await request.arrayBuffer()) : undefined;
    credential = await requireBridgeCredential(request, rawBody);

    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("multipart/form-data")) {
      throw new ApiError(400, "VALIDATION_ERROR", "The upload must be sent as multipart/form-data.");
    }
    let form: FormData;
    try {
      if (rawBody) {
        const headers = new Headers();
        headers.set("content-type", contentType);
        form = await new Request(request.url, { method: "POST", headers, body: rawBody }).formData();
      } else {
        form = await request.formData();
      }
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
    const [settings, stats] = await Promise.all([getSettings(), getStorageStats()]);
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
      await storage.upload({ key: objectKey, body: bytes, contentType: document.mimeType, contentLength: size });
    } catch (error) {
      try { await storage.delete(objectKey); } catch { /* compensation cleanup is best-effort */ }
      if (isApiError(error)) throw error;
      throw new ApiError(502, "R2_UPLOAD_FAILED", "The document could not be stored. Please retry shortly.");
    }

    try {
      const metadata = await storage.getMetadata(objectKey);
      if (metadata.contentLength !== size) {
        throw new ApiError(502, "R2_UPLOAD_FAILED", "The stored document could not be verified.");
      }
    } catch (error) {
      try { await storage.delete(objectKey); } catch { /* compensation cleanup is best-effort */ }
      if (isApiError(error) && error.code === "R2_UPLOAD_FAILED") throw error;
      if (isApiError(error)) throw error;
      throw new ApiError(502, "R2_UPLOAD_FAILED", "The stored document could not be verified.");
    }

    // Sign the URL before registration so a registration failure can still
    // remove the orphaned object without leaving a signed URL dangling.
    let signed: { url: string; expiresAt: string };
    try {
      signed = await signBridgeDocumentUrl({ ...({} as FileDocument), storageKey: objectKey, originalName: filename, mimeType: document.mimeType });
    } catch (error) {
      try { await storage.delete(objectKey); } catch { /* compensation cleanup is best-effort */ }
      if (isApiError(error)) throw error;
      throw new ApiError(502, "STORAGE_UNAVAILABLE", "A signed document URL could not be generated. Please retry shortly.");
    }

    let file: FileDocument;
    try {
      file = await createBridgeFile({
        storageKey: objectKey,
        originalName: filename,
        title: textField("title").trim().replace(/\s+/g, " ").slice(0, 160) || stripDocumentExtension(filename),
        description: textField("description").trim().replace(/\s+/g, " ").slice(0, 2000),
        category: textField("category").trim().replace(/\s+/g, " ").slice(0, 80),
        tags: parseBridgeTags(textField("tags") || null),
        mimeType: document.mimeType,
        extension: document.extension,
        size,
        uploadedBy: bridgeUploader(credential),
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
    });
    await logBridgeUploadAttempt({ keyId: credential.logKey, filename, sizeBytes: size, status: "success", failureCode: null, requestId });

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
 * documents. Mints a short-lived R2 PUT URL; the integration uploads bytes
 * directly to R2 (bypassing Vercel's function payload limit entirely), then
 * calls .../complete.
 */
export async function handleBridgeUploadInit(request: Request, requestId: string): Promise<Response> {
  enforceRateLimit(`bridge:upload-init:${getClientIp(request)}`, 120);
  const rawBody = await readBoundedJsonBody(request);
  const credential = await requireBridgeCredential(request, rawBody);
  const input = parseBridgeJson(rawBody, bridgeUploadInitSchema);

  const [settings, stats] = await Promise.all([getSettings(), getStorageStats()]);
  const effectiveMax = Math.min(settings.maxPdfSizeBytes, getBridgeMaxDocumentBytes());
  const document = assertDocumentMetadata(input.originalName, input.size, effectiveMax, input.mimeType || undefined);
  if (stats.totalStorageBytes + stats.pendingUploadBytes + input.size > settings.storageLimitBytes) {
    throw new ApiError(409, "STORAGE_LIMIT_EXCEEDED", "Uploading this document would exceed the configured storage limit.");
  }

  const file = await createUploadingFile({
    storageKey: buildBridgeObjectKey(document.extension),
    uploadKey: buildBridgeStagingKey(document.extension),
    originalName: input.originalName,
    title: input.title || stripDocumentExtension(input.originalName),
    description: input.description,
    category: input.category,
    tags: input.tags,
    mimeType: document.mimeType,
    extension: document.extension,
    size: input.size,
    uploadedBy: bridgeUploader(credential),
    retention: defaultRetention(settings),
  });

  try {
    const expiresInSeconds = Math.min(20 * 60, Math.max(5 * 60, settings.signedUrlExpirySeconds));
    const uploadUrl = await getStorageService().getSignedUploadUrl(file.uploadKey!, {
      expiresInSeconds,
      contentType: document.mimeType,
      contentLength: file.size,
      metadata: { "file-id": file.id },
    });
    return success({
      file: serializeFile(file),
      uploadUrl,
      uploadHeaders: {
        "Content-Type": document.mimeType,
        "x-amz-meta-file-id": file.id,
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
 * Verifies the staged R2 object (size, content type, ownership, magic bytes),
 * publishes it to its final key, and returns the signed document URL. Only the
 * credential that started the upload may complete it.
 */
export async function handleBridgeUploadComplete(request: Request, requestId: string): Promise<Response> {
  enforceRateLimit(`bridge:upload-complete:${getClientIp(request)}`, 120);
  const rawBody = await readBoundedJsonBody(request);
  const credential = await requireBridgeCredential(request, rawBody);
  const input = parseBridgeJson(rawBody, bridgeUploadCompleteSchema);
  const expectedUploader = bridgeUploader(credential);

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
    const stagingKey = file.uploadKey ?? file.storageKey;
    let verifiedEtag: string | undefined;
    try {
      const [metadata, firstBytes, lastBytes] = await Promise.all([
        storage.getMetadata(stagingKey),
        storage.download(stagingKey, `bytes=0-${SNIFF_WINDOW_BYTES - 1}`),
        storage.download(stagingKey, `bytes=-${SNIFF_WINDOW_BYTES}`),
      ]);
      verifiedEtag = metadata.etag;
      assertValidatedR2Document({
        originalName: file.originalName,
        expectedSize: file.size,
        actualSize: metadata.contentLength,
        contentType: metadata.contentType,
        firstBytes,
        lastBytes,
        objectFileId: metadata.metadata?.["file-id"],
        expectedFileId: file.id,
      });
    } catch (error) {
      if (isApiError(error) && VALIDATION_CODES.has(error.code)) {
        try { await storage.delete(stagingKey); } catch { /* stale upload cleanup will retry if needed */ }
        await markUploadFailed(file.id, error.code);
        await writeAuditLogSafely({ action: "UPLOAD_FAILED", actor: auditActorFrom(INTEGRATION_AUDIT_ACTOR), fileId: file.id, fileName: file.originalName, details: { reason: error.code } });
        throw error;
      }
      if (isApiError(error)) throw error;
      throw new ApiError(502, "STORAGE_UNAVAILABLE", "The document could not be verified in storage. Please retry shortly.");
    }

    try {
      // Publish an immutable final object. The upload URL only authorizes its separate staging key.
      if (stagingKey !== file.storageKey) await storage.copy(stagingKey, file.storageKey, verifiedEtag);
    } catch {
      throw new ApiError(502, "STORAGE_UNAVAILABLE", "The verified document could not be finalized in storage. Please retry shortly.");
    }
    const active = await activateUpload(file.id);
    try { await storage.delete(stagingKey); await clearUploadKey(file.id); } catch { /* safe, retryable staging cleanup */ }
    await writeAuditLogSafely({ action: "BRIDGE_UPLOAD", actor: auditActorFrom(INTEGRATION_AUDIT_ACTOR), fileId: active.id, fileName: active.originalName, details: { size: active.size } });

    const signed = await signBridgeDocumentUrl(active);
    await logBridgeUploadAttempt({ keyId: credential.logKey, filename, sizeBytes: active.size, status: "success", failureCode: null, requestId });
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
