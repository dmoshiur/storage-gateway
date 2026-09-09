import { apiRoute } from "@/lib/api/route";
import { parseJson } from "@/lib/api/body";
import { success } from "@/lib/api/response";
import { ApiError } from "@/lib/api/errors";
import { verifyAdminPass } from "@/lib/env";
import { assertSameOrigin, getClientIp } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { adminGateSchema } from "@/lib/validation/schemas";

export const runtime = "nodejs";

/**
 * Verifies the shared administrator passphrase (ADMIN_PASS) before the Firebase
 * email/password form is revealed. Access to the actual dashboard still requires
 * the server-verified Firebase session cookie issued by /api/auth/session.
 */
export async function POST(request: Request) {
  return apiRoute(request, async (requestId) => {
    assertSameOrigin(request);
    enforceRateLimit(`gate:${getClientIp(request)}`, 10);
    const { adminPass } = await parseJson(request, adminGateSchema, 1024);
    if (!verifyAdminPass(adminPass)) {
      throw new ApiError(401, "ADMIN_PASS_INVALID", "The administrator passphrase is incorrect.");
    }
    return success({ passphraseAccepted: true }, requestId);
  }, { route: "auth/gate" });
}
