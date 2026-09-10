import { z } from "zod";
import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { parseJson } from "@/lib/api/body";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { createCategory, listCategories } from "@/lib/firestore/categories";

export const runtime = "nodejs";

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(200).optional(),
  color: z.string().trim().min(1).max(24).optional(),
});

export async function GET(request: Request) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "read_files");
    enforceRateLimit(`categories:list:${actor.uid}`, 120);
    return success({ categories: await listCategories() }, requestId);
  }, { route: "categories/list" });
}

export async function POST(request: Request) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "manage_files", true);
    enforceRateLimit(`categories:create:${actor.uid}`, 30);
    const input = await parseJson(request, createSchema);
    const category = await createCategory(input);
    return success({ category }, requestId, 201);
  }, { route: "categories/create" });
}
