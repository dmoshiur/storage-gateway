import { z } from "zod";
import { apiRoute, requireRouteId } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { parseQuery } from "@/lib/api/body";
import { ApiError } from "@/lib/api/errors";
import { recordFileAccess, requireFileById } from "@/lib/db/files";
import { getSettings } from "@/lib/db/settings";
import { writeAuditLogSafely, auditActorFrom } from "@/lib/db/audit";
import { getStorageService } from "@/lib/storage";
import { streamStoredFile } from "@/lib/files/serve";
import { requireReadActor } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";

const previewQuerySchema = z.object({
  redirect: z.enum(["true", "false"]).optional().default("false"),
  /**
   * `stream=true` proxies the PDF bytes through this authenticated route, so
   * the browser never receives a Blob URL. The default stays the short-lived
   * signed URL for callers that only need a link.
   */
  stream: z.enum(["true", "false"]).optional().default("false"),
});

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireReadActor(request, "files:download");
    enforceRateLimit(`files:preview:${actor.type}:${actor.uid}`, actor.type === "integration" ? 120 : 240);
    const query = parseQuery(Object.fromEntries(new URL(request.url).searchParams.entries()), previewQuerySchema);
    const file = await requireFileById(requireRouteId((await context.params).id));
    if (file.status !== "active" || (actor.type === "integration" && file.autoDeleteEnabled && file.deleteAt && file.deleteAt <= new Date())) {
      throw new ApiError(404, "FILE_NOT_FOUND", "The requested document was not found.");
    }

    // Authenticated + authorized + metadata loaded: now serve the private bytes.
    if (query.stream === "true") {
      const response = await streamStoredFile(file, {
        disposition: "inline",
        range: request.headers.get("range") ?? undefined,
        requestId,
      });
      await recordFileAccess(file.id, "preview");
      await writeAuditLogSafely({ action: "PREVIEW", actor: auditActorFrom(actor), fileId: file.id, fileName: file.originalName, details: { via: "stream" }, requestId });
      return response;
    }

    const settings = await getSettings();
    const expirySeconds = Math.min(settings.signedUrlExpirySeconds, 600);
    const url = await getStorageService().getSignedUrl(file.storagePath, {
      expiresInSeconds: expirySeconds,
      disposition: "inline",
      filename: file.originalName,
      contentType: file.mimeType,
    });
    await recordFileAccess(file.id, "preview");
    await writeAuditLogSafely({ action: "PREVIEW", actor: auditActorFrom(actor), fileId: file.id, fileName: file.originalName, requestId });
    if (query.redirect === "true") {
      const response = Response.redirect(url, 302);
      response.headers.set("Cache-Control", "no-store");
      response.headers.set("X-Request-Id", requestId);
      return response;
    }
    return success({ url, expiresAt: new Date(Date.now() + expirySeconds * 1000).toISOString() }, requestId);
  }, { route: "files/preview" });
}
