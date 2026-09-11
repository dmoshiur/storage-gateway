import { z } from "zod";
import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { parseJson } from "@/lib/api/body";
import { ApiError, isApiError } from "@/lib/api/errors";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { actorFromClaims } from "@/lib/auth/session";
import { getAdminAuth } from "@/lib/firebase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const verifySchema = z.object({ idToken: z.string().min(100).max(12_000) });

function mapVerifyError(error: unknown): ApiError {
  // A 5xx ApiError (missing/malformed Admin credentials) must surface as a
  // configuration failure, never as an invalid login.
  if (isApiError(error) && error.status >= 500) return error;
  const code = (error as { code?: string })?.code ?? "";
  const message = error instanceof Error ? error.message : String(error);
  const combined = `${code} ${message}`.toLowerCase();

  if (combined.includes("audience") || combined.includes("incorrect \"aud\"") || combined.includes("incorrect 'aud'")) {
    const match = message.match(/Expected "([^"]+)" but got "([^"]+)"/) ?? message.match(/expected ([a-z0-9-]+) but got ([a-z0-9-]+)/i);
    const expected = match?.[1] ? ` Server Admin expects project “${match[1]}”` : "";
    const got = match?.[2] ? ` but the sign-in token came from project “${match[2]}”` : "";
    return new ApiError(
      400,
      "WRONG_PROJECT",
      `This sign-in belongs to a different Firebase project than the server verifies.${expected}${got}. ` +
        "Use Web and Admin credentials from the same project.",
    );
  }
  if (combined.includes("id-token-expired") || combined.includes("token-expired")) {
    return new ApiError(401, "TOKEN_EXPIRED", "The sign-in token expired before it could be verified. Sign in again and retry.");
  }
  if (combined.includes("id-token-revoked") || combined.includes("revoked")) {
    return new ApiError(401, "TOKEN_REVOKED", "This sign-in was revoked. Sign in again and retry.");
  }
  if (combined.includes("user-disabled")) {
    return new ApiError(403, "USER_DISABLED", "This Firebase account is disabled.");
  }
  if (combined.includes("user-not-found") || combined.includes("no user record")) {
    return new ApiError(401, "USER_DELETED", "The Firebase user for this sign-in no longer exists.");
  }
  if (combined.includes("project-not-found") || combined.includes("configuration-not-found")) {
    return new ApiError(503, "ADMIN_PROJECT_NOT_FOUND", "The server's Firebase Admin project was not found. Check the FIREBASE_* variables in Vercel.");
  }
  if (combined.includes("invalid-credential") || combined.includes("credential") || combined.includes("private key")) {
    return new ApiError(
      503,
      "SERVICE_CONFIGURATION_ERROR",
      "The server's Firebase Admin credential is invalid. Check FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY in Vercel and redeploy.",
    );
  }
  if (combined.includes("issuer") || combined.includes("incorrect \"iss\"") || combined.includes("invalid-argument") || combined.includes("invalid id token") || combined.includes("id token")) {
    return new ApiError(401, "INVALID_ID_TOKEN", `The sign-in token failed verification (${message.slice(0, 180)}).`);
  }
  return new ApiError(401, "INVALID_ID_TOKEN", "The sign-in could not be verified. Please sign in again.");
}

/**
 * End-to-end login verification WITHOUT touching the operator's session:
 * verifies a freshly minted Firebase ID token (from the isolated browser
 * sign-in in Settings → Verify login) with the Admin SDK and resolves the
 * role exactly as POST /api/auth/session would. No session cookie is minted.
 */
export async function POST(request: Request) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "manage_settings", true);
    enforceRateLimit(`firebase-config:verify:${actor.uid}`, 10);
    const { idToken } = await parseJson(request, verifySchema, 16 * 1024);
    try {
      const auth = getAdminAuth();
      const decoded = await auth.verifyIdToken(idToken, true);
      const verified = actorFromClaims(decoded);
      let disabled = false;
      try {
        disabled = (await auth.getUser(decoded.uid)).disabled;
      } catch {
        // Non-fatal: token verification already succeeded; account lookup is advisory.
      }
      if (disabled) {
        throw new ApiError(403, "USER_DISABLED", "This Firebase account is disabled.");
      }
      return success({
        uid: verified.uid,
        email: verified.email,
        role: verified.role,
        projectId: decoded.aud,
      }, requestId);
    } catch (error) {
      throw mapVerifyError(error);
    }
  }, { route: "firebase-config/verify-login" });
}
