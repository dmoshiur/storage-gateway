import { z } from "zod";
import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { parseJson } from "@/lib/api/body";
import { ApiError } from "@/lib/api/errors";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { deleteCategory, updateCategory } from "@/lib/db/categories";

export const runtime = "nodejs";

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(200).optional(),
  color: z.string().trim().min(1).max(24).optional(),
}).refine((data) => Object.keys(data).length > 0, "Provide at least one field to update.");

function routeId(value: string): string {
  if (!value || value.length > 200) throw new ApiError(400, "VALIDATION_ERROR", "The category id is invalid.");
  return value;
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "manage_files", true);
    enforceRateLimit(`categories:update:${actor.uid}`, 60);
    const input = await parseJson(request, updateSchema);
    const category = await updateCategory(routeId((await context.params).id), input);
    return success({ category }, requestId);
  }, { route: "categories/update" });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "manage_files", true);
    enforceRateLimit(`categories:delete:${actor.uid}`, 30);
    await deleteCategory(routeId((await context.params).id));
    return success({ deleted: true }, requestId);
  }, { route: "categories/delete" });
}
