import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { parseJson } from "@/lib/api/body";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { getSettings, serializeSettings, updateSettings } from "@/lib/firestore/settings";
import { applyDefaultRetentionToActiveFiles } from "@/lib/firestore/files";
import { writeAuditLogSafely, auditActorFrom } from "@/lib/firestore/audit";
import { settingsPatchSchema } from "@/lib/validation/schemas";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "manage_settings");
    enforceRateLimit(`settings:get:${actor.uid}`, 120);
    return success({ settings: serializeSettings(await getSettings()) }, requestId);
  }, { route: "settings/get" });
}

export async function PATCH(request: Request) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "manage_settings", true);
    enforceRateLimit(`settings:update:${actor.uid}`, 20);
    const { applyToExisting, ...input } = await parseJson(request, settingsPatchSchema);
    const current = await getSettings();
    const changed = Object.keys(input).filter((key) => current[key as keyof typeof current] !== input[key as keyof typeof input]);
    const settings = await updateSettings(input, actor.uid);
    const updatedFiles = applyToExisting
      ? await applyDefaultRetentionToActiveFiles({ autoDeleteEnabled: settings.defaultAutoDelete, retentionType: settings.defaultRetentionType })
      : 0;
    await writeAuditLogSafely({
      action: "SETTINGS_CHANGE",
      actor: auditActorFrom(actor),
      details: { changed: changed.join(","), applyToExisting, updatedFiles },
    });
    return success({ settings: serializeSettings(settings), updatedFiles }, requestId);
  }, { route: "settings/update" });
}
