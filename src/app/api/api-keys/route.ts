import { z } from "zod";
import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { parseJson } from "@/lib/api/body";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import {
  BEARER_API_SCOPES,
  createBearerKey,
  listBearerKeys,
  revokeBearerKey,
  rotateBearerKey,
} from "@/lib/security/bearer-keys";
import { API_SCOPES } from "@/lib/security/api-keys";
import { writeAuditLogSafely, auditActorFrom } from "@/lib/firestore/audit";
import { createNotificationSafe } from "@/lib/firestore/notifications";
import { ApiError } from "@/lib/api/errors";

export const runtime = "nodejs";

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(280).optional(),
  scopes: z.array(z.enum(API_SCOPES)).min(1).optional(),
  // Optional ISO date; null/omitted means the key never expires.
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
});

const updateSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(280).optional(),
  scopes: z.array(z.enum(API_SCOPES)).min(1).optional(),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
});

export async function GET(request: Request) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "manage_api");
    enforceRateLimit(`api-keys:list:${actor.uid}`, 60);
    return success({ keys: await listBearerKeys(), availableScopes: [...BEARER_API_SCOPES] }, requestId);
  }, { route: "api-keys/list" });
}

export async function POST(request: Request) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "manage_api", true);
    enforceRateLimit(`api-keys:create:${actor.uid}`, 20);
    const input = await parseJson(request, createSchema);
    const created = await createBearerKey(actor.uid, {
      name: input.name,
      description: input.description,
      scopes: input.scopes,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    });
    await writeAuditLogSafely({
      action: "API_KEY_CREATED",
      actor: auditActorFrom(actor),
      details: { keyId: created.keyId, name: created.name },
    });
    await createNotificationSafe({
      type: "api_key_created",
      title: "API key created",
      message: `“${created.name}” was created.`,
      link: "/admin/api",
    });
    // The raw secret is returned exactly once.
    return success(created, requestId, 201);
  }, { route: "api-keys/create" });
}

export async function PATCH(request: Request) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "manage_api", true);
    enforceRateLimit(`api-keys:update:${actor.uid}`, 60);
    const input = await parseJson(request, updateSchema);
    const url = new URL(request.url);
    if (url.searchParams.get("rotate") === "true") {
      const rotated = await rotateBearerKey(input.id);
      await writeAuditLogSafely({
        action: "API_KEY_ROTATED",
        actor: auditActorFrom(actor),
        details: { keyId: rotated.keyId },
      });
      return success(rotated, requestId);
    }
    // Placeholder for future metadata edits; currently only rotation is exposed.
    throw new ApiError(400, "UNSUPPORTED_UPDATE", "Only rotation is supported for this key.");
  }, { route: "api-keys/update" });
}

export async function DELETE(request: Request) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "manage_api", true);
    enforceRateLimit(`api-keys:revoke:${actor.uid}`, 30);
    const keyId = new URL(request.url).searchParams.get("id");
    if (!keyId) throw new ApiError(400, "VALIDATION_ERROR", "A key id is required.");
    await revokeBearerKey(keyId);
    await writeAuditLogSafely({
      action: "API_KEY_REVOKED",
      actor: auditActorFrom(actor),
      details: { id: keyId },
    });
    await createNotificationSafe({
      type: "api_key_revoked",
      title: "API key revoked",
      message: "An API key was revoked. Integrations using it will stop working.",
      link: "/admin/api",
    });
    return success({ revoked: true }, requestId);
  }, { route: "api-keys/revoke" });
}
