import { z } from "zod";
import { apiRoute } from "@/lib/api/route";
import { parseQuery } from "@/lib/api/body";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { listFilesForStats, serializeFile } from "@/lib/db/files";
import { writeAuditLogSafely, auditActorFrom } from "@/lib/db/audit";

export const runtime = "nodejs";

const exportQuerySchema = z.object({
  format: z.enum(["csv", "json"]).default("csv"),
  status: z.enum(["active", "trash", "all"]).default("active"),
});

function csvCell(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function GET(request: Request) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "read_files");
    enforceRateLimit(`files:export:${actor.uid}`, 10);
    const query = parseQuery(Object.fromEntries(new URL(request.url).searchParams.entries()), exportQuerySchema);

    const all = await listFilesForStats();
    const files = all
      .filter((file) => query.status === "all" || file.status === query.status)
      .map(serializeFile);
    await writeAuditLogSafely({
      action: "EXPORT",
      actor: auditActorFrom(actor),
      details: { format: query.format, status: query.status, count: files.length },
      requestId,
    });

    if (query.format === "json") {
      return new Response(JSON.stringify({ success: true, data: { files }, requestId }, null, 2), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": `attachment; filename="ngo-file-cloud-export-${Date.now()}.json"`,
          "X-Request-Id": requestId,
          "Cache-Control": "no-store",
        },
      });
    }

    const header = ["id", "originalName", "title", "size", "mimeType", "category", "tags", "createdAt", "updatedAt", "uploadedBy", "retentionType", "autoDeleteEnabled", "deleteAt", "status", "deletedAt", "isFavorite"];
    const rows = files.map((file) => [
      csvCell(file.id),
      csvCell(file.originalName),
      csvCell(file.title),
      file.size,
      csvCell(file.mimeType),
      csvCell(file.category),
      csvCell(file.tags.join(";")),
      csvCell(file.createdAt),
      csvCell(file.updatedAt),
      csvCell(file.uploadedBy),
      csvCell(file.retentionType),
      file.autoDeleteEnabled ? "true" : "false",
      csvCell(file.deleteAt),
      csvCell(file.status),
      csvCell(file.deletedAt),
      file.isFavorite ? "true" : "false",
    ].join(","));
    return new Response([header.join(","), ...rows].join("\n"), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="ngo-file-cloud-export-${Date.now()}.csv"`,
        "X-Request-Id": requestId,
        "Cache-Control": "no-store",
      },
    });
  }, { route: "files/export" });
}
