import { z } from "zod";
import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { parseJson } from "@/lib/api/body";
import { ApiError } from "@/lib/api/errors";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { getEffectiveFirebaseWebConfig } from "@/lib/firebase/runtime-store";
import { probeFirebaseWebConfigServer } from "@/lib/firebase/probe";
import { firebaseWebConfigSchema } from "@/lib/firebase/web-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const testSchema = z.object({ config: firebaseWebConfigSchema.optional() });

/**
 * Authoritative server-side connection test: shape → Auth → Email/Password
 * provider → Firestore → Admin SDK project match. Accepts an optional
 * candidate config (tests the pasted-but-unsaved JSON); without one it
 * tests the currently effective configuration.
 */
export async function POST(request: Request) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "manage_settings", true);
    enforceRateLimit(`firebase-config:test:${actor.uid}`, 10);
    const { config: candidate } = await parseJson(request, testSchema, 8 * 1024);
    const config = candidate ?? (await getEffectiveFirebaseWebConfig()).config;
    if (!config) {
      throw new ApiError(
        400,
        "FIREBASE_NOT_CONFIGURED",
        "No Firebase configuration is available to test. Paste a Web App config first.",
      );
    }
    const report = await probeFirebaseWebConfigServer(config);
    return success(report, requestId);
  }, { route: "firebase-config/test" });
}
