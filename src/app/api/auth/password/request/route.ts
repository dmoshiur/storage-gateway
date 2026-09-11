import { parseJson } from "@/lib/api/body";
import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { issuePasswordResetToken } from "@/lib/auth/password-reset";
import { assertSameOrigin, getClientIp } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { passwordResetRequestSchema } from "@/lib/validation/schemas";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return apiRoute(request, async (requestId) => {
    assertSameOrigin(request);
    enforceRateLimit(`password-reset:${getClientIp(request)}`, 5);
    const { email } = await parseJson(request, passwordResetRequestSchema, 16 * 1024);
    const token = await issuePasswordResetToken(email);
    // Production delivery is intentionally not delegated to an identity SaaS.
    // Set up the organization's SMTP/notification worker to deliver the token;
    // returning it is allowed only for local development or explicit testing.
    const exposeToken = process.env.NODE_ENV !== "production";
    return success({ requested: true, ...(exposeToken && token ? { resetToken: token } : {}) }, requestId);
  }, { route: "auth/password/request" });
}
