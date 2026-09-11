import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { parseJson } from "@/lib/api/body";
import { requireIntegrationKey } from "@/lib/security/request-auth";
import { bridgeRegisterFileSchema } from "@/lib/validation/bridge";
import { assertDocumentMetadata, assertValidatedBlobDocument, stripDocumentExtension } from "@/lib/validation/documents";
import { createBridgeFile, serializeFile } from "@/lib/db/files";
import { getSettings } from "@/lib/db/settings";
import { getStorageStats } from "@/lib/db/stats";
import { writeAuditLogSafely, auditActorFrom } from "@/lib/db/audit";
import { defaultRetention } from "@/lib/retention";
import { getStorageService } from "@/lib/storage";
import { ApiError } from "@/lib/api/errors";
import { toServiceFailure } from "@/lib/api/failures";

export const runtime = "nodejs";

/**
 * Internal, server-to-server metadata registration for bridge uploads.
 *
 * A trusted server-side uploader validates the document structure itself
 * (header, EOF marker, declared size) and streams the bytes straight into the
 * private Blob store. Only after the object exists and passes verification
 * does the uploader call this endpoint so the document becomes visible to the
 * dashboard, retention, Trash, and NGO website listing with one source of
 * truth for metadata. Blob credentials never travel to the client site. The
 * embedded bridge registers documents in-process and does not use this route.
 */
export async function POST(request: Request) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireIntegrationKey(request, "files:upload");
    const input = await parseJson(request, bridgeRegisterFileSchema, 32 * 1024);
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
        operation: "internal/bridge/files:limits",
        area: "database",
        requestId,
      });
    }
    const document = assertDocumentMetadata(input.originalName, input.size, settings.maxPdfSizeBytes, input.mimeType);
    if (stats.totalStorageBytes + input.size > settings.storageLimitBytes) {
      throw new ApiError(409, "STORAGE_LIMIT_EXCEEDED", "Uploading this document would exceed the configured storage limit.");
    }
    const storage = getStorageService();
    const [metadata, firstBytes, lastBytes] = await Promise.all([
      storage.getMetadata(input.storagePath),
      storage.download(input.storagePath, "bytes=0-2047"),
      storage.download(input.storagePath, "bytes=-2048"),
    ]);
    assertValidatedBlobDocument({
      originalName: input.originalName,
      expectedSize: input.size,
      actualSize: metadata.contentLength,
      contentType: metadata.contentType,
      firstBytes,
      lastBytes,
    });

    const file = await createBridgeFile({
      storagePath: input.storagePath,
      originalName: input.originalName,
      title: input.title || stripDocumentExtension(input.originalName),
      description: input.description,
      category: input.category,
      tags: input.tags,
      mimeType: document.mimeType,
      extension: document.extension,
      size: input.size,
      uploadedBy: actor.uid,
      retention: defaultRetention(settings),
    });

    await writeAuditLogSafely({
      action: "BRIDGE_UPLOAD",
      actor: auditActorFrom(actor),
      fileId: file.id,
      fileName: file.originalName,
      details: { size: file.size },
      requestId,
    });
    return success({ file: serializeFile(file) }, requestId, 201);
  }, { route: "internal/bridge/files" });
}
