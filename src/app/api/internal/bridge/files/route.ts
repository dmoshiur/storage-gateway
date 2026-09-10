import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { parseJson } from "@/lib/api/body";
import { requireIntegrationKey } from "@/lib/security/request-auth";
import { bridgeRegisterFileSchema } from "@/lib/validation/bridge";
import { assertDocumentMetadata, stripDocumentExtension } from "@/lib/validation/documents";
import { createBridgeFile, serializeFile } from "@/lib/firestore/files";
import { getSettings } from "@/lib/firestore/settings";
import { getStorageStats } from "@/lib/firestore/stats";
import { writeAuditLogSafely, auditActorFrom } from "@/lib/firestore/audit";
import { defaultRetention } from "@/lib/retention";
import { ApiError } from "@/lib/api/errors";

export const runtime = "nodejs";

/**
 * Internal, server-to-server metadata registration for bridge uploads.
 *
 * The optional external (legacy FastAPI) bridge validates the document structure
 * itself (header, EOF marker, declared size) and streams the bytes straight
 * into R2 with its own private R2 credentials. Only after the object exists
 * and passes a HEAD verification does the bridge call this endpoint so the
 * document becomes visible to the dashboard, retention, Trash, and NGO website
 * listing with one source of truth for metadata. R2 credentials never travel
 * to the client site. The embedded bridge registers documents in-process and
 * does not use this route.
 */
export async function POST(request: Request) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireIntegrationKey(request);
    const input = await parseJson(request, bridgeRegisterFileSchema, 32 * 1024);
    const [settings, stats] = await Promise.all([getSettings(), getStorageStats()]);
    const document = assertDocumentMetadata(input.originalName, input.size, settings.maxPdfSizeBytes, input.mimeType);
    if (stats.totalStorageBytes + input.size > settings.storageLimitBytes) {
      throw new ApiError(409, "STORAGE_LIMIT_EXCEEDED", "Uploading this document would exceed the configured storage limit.");
    }

    const file = await createBridgeFile({
      storageKey: input.storageKey,
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
    });
    return success({ file: serializeFile(file) }, requestId, 201);
  }, { route: "internal/bridge/files" });
}
