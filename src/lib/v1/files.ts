import "server-only";

import { z } from "zod";
import { ApiError } from "@/lib/api/errors";
import { success } from "@/lib/api/response";
import { parseQuery } from "@/lib/api/body";
import { getClientIp } from "@/lib/security/request-auth";
import type { ApiRequestContext } from "@/lib/db/api-metrics";
import { enforceRateLimit, enforceDatabaseRateLimit } from "@/lib/security/rate-limit";
import { hasBridgeCredentialHeaders, requireBridgeCredential, type BridgeCredential } from "@/lib/bridge/auth";
import { getApiKeyScopes, requireScope, type ApiScope } from "@/lib/security/api-keys";
import {
  bearerTokenFrom,
  requireBearerScope,
  verifyBearerKeySafely,
} from "@/lib/security/bearer-keys";
import { withBridgeCors } from "@/lib/bridge/upload";
import {
  getFileById,
  listFiles,
  moveFileToTrash,
  restoreFileFromTrash,
  serializeFile,
  updateFileDetails,
} from "@/lib/db/files";
import { getSettings } from "@/lib/db/settings";
import { getStorageService } from "@/lib/storage";
import { calculateDeleteAt } from "@/lib/retention";
import { auditActorFrom, writeAuditLogSafely } from "@/lib/db/audit";
import { emitWebhookEvent } from "@/lib/webhooks/dispatch";
import { fileUpdateSchema } from "@/lib/validation/schemas";

const INTEGRATION_AUDIT_ACTOR = { uid: "website-integration", email: null, type: "integration" } as const;

const listQuerySchema = z.object({
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(500).optional(),
  sort: z.enum(["newest", "oldest", "largest", "smallest", "delete_date", "name"]).default("newest"),
  search: z.string().trim().max(100).optional().default(""),
  category: z.string().trim().max(80).optional().default(""),
});

function invalidApiKey(): ApiError {
  return new ApiError(401, "INVALID_API_KEY", "Missing or invalid API key. Send Authorization: Bearer ng_live_….");
}

async function authorize(request: Request, requestId: string, scope: ApiScope, rateKey: string, limit: number): Promise<{
  mode: "bearer" | "bridge";
  keyId: string | null;
  recordId: string | null;
  credential: BridgeCredential | null;
}> {
  enforceRateLimit(`${rateKey}:${getClientIp(request)}`, limit);
  await enforceDatabaseRateLimit(`${rateKey}:${getClientIp(request)}`, limit);

  const requestContext: ApiRequestContext = { method: request.method, path: new URL(request.url).pathname, requestId, ip: getClientIp(request) };
  const bearer = bearerTokenFrom(request);
  if (bearer) {
    const verified = await verifyBearerKeySafely(bearer, requestContext);
    if (!verified) throw invalidApiKey();
    requireBearerScope(verified.scopes, scope);
    return { mode: "bearer", keyId: verified.keyId, recordId: verified.recordId, credential: null };
  }

  if (!hasBridgeCredentialHeaders(request)) throw invalidApiKey();
  const credential = await requireBridgeCredential(request, requestContext);
  const scopes = await getApiKeyScopes(credential.recordId);
  requireScope(scopes, scope);
  return { mode: "bridge", keyId: credential.keyId, recordId: credential.recordId, credential };
}

function cors(response: Response, request: Request): Response {
  return withBridgeCors(response, request);
}

export async function handleV1ListFiles(request: Request, requestId: string): Promise<Response> {
  await authorize(request, requestId, "files:read", "v1:files:list", 240);
  const query = parseQuery(Object.fromEntries(new URL(request.url).searchParams.entries()), listQuerySchema);
  const result = await listFiles({
    pageSize: query.pageSize,
    cursor: query.cursor,
    status: "active",
    filter: "active",
    sort: query.sort,
    search: query.search,
    category: query.category,
    onlyAccessible: true,
  });
  return cors(success(result, requestId), request);
}

export async function handleV1GetFile(request: Request, requestId: string, id: string): Promise<Response> {
  await authorize(request, requestId, "metadata:read", "v1:files:get", 480);
  const file = await getFileById(id);
  const now = new Date();
  if (!file || file.status !== "active" || (file.autoDeleteEnabled && file.deleteAt && file.deleteAt <= now)) {
    throw new ApiError(404, "FILE_NOT_FOUND", "The requested file was not found.");
  }
  return cors(success({ file: serializeFile(file) }, requestId), request);
}

export async function handleV1UpdateFile(request: Request, requestId: string, id: string): Promise<Response> {
  const auth = await authorize(request, requestId, "metadata:write", "v1:files:update", 120);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError(400, "INVALID_JSON", "The request body must be valid JSON.");
  }
  const parsed = fileUpdateSchema.safeParse(body);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) fields[issue.path.join(".") || "body"] = issue.message;
    throw new ApiError(400, "VALIDATION_ERROR", "Some information is missing or invalid.", fields);
  }
  const result = await updateFileDetails(id, parsed.data);
  await writeAuditLogSafely({
    action: "UPDATE_METADATA",
    actor: auditActorFrom(INTEGRATION_AUDIT_ACTOR),
    fileId: result.file.id,
    fileName: result.file.originalName,
    details: { via: "api-v1", auth: auth.mode, ...(auth.keyId ? { keyId: auth.keyId } : {}) },
    requestId,
  });
  emitWebhookEvent("file.updated", { fileId: result.file.id, fileName: result.file.originalName, via: "api" });
  return cors(success({ file: serializeFile(result.file) }, requestId), request);
}

export async function handleV1DeleteFile(request: Request, requestId: string, id: string): Promise<Response> {
  const auth = await authorize(request, requestId, "files:delete", "v1:files:delete", 60);
  const settings = await getSettings();
  const file = await moveFileToTrash(id, settings.trashRetentionDays, "manual");
  await writeAuditLogSafely({
    action: "MOVE_TO_TRASH",
    actor: auditActorFrom(INTEGRATION_AUDIT_ACTOR),
    fileId: file.id,
    fileName: file.originalName,
    details: { via: "api-v1", auth: auth.mode, ...(auth.keyId ? { keyId: auth.keyId } : {}) },
    requestId,
  });
  emitWebhookEvent("file.trashed", { fileId: file.id, fileName: file.originalName, via: "api" });
  return cors(success({ file: serializeFile(file) }, requestId), request);
}

export async function handleV1RestoreFile(request: Request, requestId: string, id: string): Promise<Response> {
  const auth = await authorize(request, requestId, "files:update", "v1:files:restore", 60);
  const file = await getFileById(id);
  if (!file || file.status !== "trash") {
    throw new ApiError(404, "FILE_NOT_FOUND", "The requested file was not found or is not in Trash.");
  }
  if (!(await getStorageService().exists(file.storagePath))) {
    throw new ApiError(409, "FILE_CONTENT_UNAVAILABLE", "This document can no longer be restored because its private object is unavailable.");
  }
  let nextDeleteAt = file.deleteAt;
  const resetElapsedCustomRetention = Boolean(file.autoDeleteEnabled && file.deleteAt && file.deleteAt <= new Date() && file.retentionType === "custom_date");
  if (file.autoDeleteEnabled && file.deleteAt && file.deleteAt <= new Date() && !resetElapsedCustomRetention) {
    nextDeleteAt = calculateDeleteAt({ autoDeleteEnabled: true, retentionType: file.retentionType, customDeleteAt: null });
  }
  const restored = await restoreFileFromTrash(file.id, { nextDeleteAt, resetElapsedCustomRetention });
  await writeAuditLogSafely({
    action: "RESTORE",
    actor: auditActorFrom(INTEGRATION_AUDIT_ACTOR),
    fileId: restored.id,
    fileName: restored.originalName,
    details: { via: "api-v1", auth: auth.mode, ...(auth.keyId ? { keyId: auth.keyId } : {}) },
    requestId,
  });
  emitWebhookEvent("file.restored", { fileId: restored.id, fileName: restored.originalName, via: "api" });
  return cors(success({ file: serializeFile(restored) }, requestId), request);
}

export async function handleV1DownloadFile(request: Request, requestId: string, id: string): Promise<Response> {
  const auth = await authorize(request, requestId, "files:download", "v1:files:download", 120);
  const file = await getFileById(id);
  const now = new Date();
  if (!file || file.status !== "active" || (file.autoDeleteEnabled && file.deleteAt && file.deleteAt <= now)) {
    throw new ApiError(404, "FILE_NOT_FOUND", "The requested file was not found.");
  }
  const settings = await getSettings();
  const url = await getStorageService().getSignedUrl(file.storagePath, {
    expiresInSeconds: Math.min(settings.signedUrlExpirySeconds, 3600),
    disposition: "attachment",
    filename: file.originalName,
    contentType: file.mimeType,
  });
  await writeAuditLogSafely({
    action: "DOWNLOAD",
    actor: auditActorFrom(INTEGRATION_AUDIT_ACTOR),
    fileId: file.id,
    fileName: file.originalName,
    details: { via: "api-v1", auth: auth.mode, ...(auth.keyId ? { keyId: auth.keyId } : {}) },
    requestId,
  });
  emitWebhookEvent("file.downloaded", { fileId: file.id, fileName: file.originalName, via: "api" });
  return cors(success({
    url,
    expiresAt: new Date(Date.now() + Math.min(settings.signedUrlExpirySeconds, 3600) * 1000).toISOString(),
    filename: file.originalName,
    size: file.size,
    mimeType: file.mimeType,
  }, requestId), request);
}
