import { z } from "zod";
import { apiRoute, requireRouteId } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { parseQuery } from "@/lib/api/body";
import { ApiError } from "@/lib/api/errors";
import { requireFileById } from "@/lib/firestore/files";
import { getSettings } from "@/lib/firestore/settings";
import { writeAuditLogSafely, auditActorFrom } from "@/lib/firestore/audit";
import { getStorageService } from "@/lib/storage";
import { requireReadActor } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";

const downloadQuerySchema = z.object({
  disposition: z.enum(["inline", "attachment"]).default("attachment"),
  redirect: z.enum(["true", "false"]).optional().default("false"),
});

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireReadActor(request);
    enforceRateLimit(`files:download:${actor.type}:${actor.uid}`, actor.type === "integration" ? 60 : 120);
    const query = parseQuery(Object.fromEntries(new URL(request.url).searchParams.entries()), downloadQuerySchema);
    const file = await requireFileById(requireRouteId((await context.params).id));
    if (file.status !== "active" || (actor.type === "integration" && file.autoDeleteEnabled && file.deleteAt && file.deleteAt <= new Date())) {
      throw new ApiError(404, "FILE_NOT_FOUND", "The requested PDF was not found.");
    }
    const settings = await getSettings();
    const url = await getStorageService().getSignedUrl(file.storageKey, {
      expiresInSeconds: settings.signedUrlExpirySeconds,
      disposition: query.disposition,
      filename: file.originalName,
    });
    await writeAuditLogSafely({ action: "DOWNLOAD", actor: auditActorFrom(actor), fileId: file.id, fileName: file.originalName, details: { disposition: query.disposition } });

    if (query.redirect === "true") {
      const response = Response.redirect(url, 302);
      response.headers.set("Cache-Control", "no-store");
      response.headers.set("X-Request-Id", requestId);
      return response;
    }
    return success({ url, expiresAt: new Date(Date.now() + settings.signedUrlExpirySeconds * 1000).toISOString(), disposition: query.disposition }, requestId);
  }, { route: "files/download" });
}
