import { apiRoute, requireRouteId } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { parseJson } from "@/lib/api/body";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { requireFileById, serializeFile, setFileFavorite } from "@/lib/firestore/files";
import { writeAuditLogSafely, auditActorFrom } from "@/lib/firestore/audit";
import { favoriteSchema } from "@/lib/validation/schemas";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "manage_files", true);
    enforceRateLimit(`files:favorite:${actor.uid}`, 120);
    const input = await parseJson(request, favoriteSchema);
    const id = requireRouteId((await context.params).id);
    await requireFileById(id);
    const file = await setFileFavorite(id, input.isFavorite);
    await writeAuditLogSafely({
      action: "FAVORITE",
      actor: auditActorFrom(actor),
      fileId: file.id,
      fileName: file.originalName,
      details: { isFavorite: input.isFavorite },
    });
    return success({ file: serializeFile(file) }, requestId);
  }, { route: "files/favorite" });
}
