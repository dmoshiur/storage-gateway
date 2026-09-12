import { NextResponse } from "next/server";
import { apiRoute } from "@/lib/api/route";
import { bridgePreflightResponse, withBridgeCors } from "@/lib/bridge/upload";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/request-auth";
import { logger } from "@/lib/logging/logger";
import { hasBridgeCredentialHeaders, requireBridgeCredential } from "@/lib/bridge/auth";
import { bearerTokenFrom, verifyBearerKeySafely } from "@/lib/security/bearer-keys";
import { ApiError } from "@/lib/api/errors";
import { API_SCOPES, type ApiScope } from "@/lib/security/scopes";
import { getStorageService } from "@/lib/storage";
import { query } from "@/lib/db/client";
import { readBlobStoreConfig } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/auth/test — "Test API Key".
 *
 * Exercises the full external-integration chain with the caller's OWN
 * credentials, using the exact same authentication code path as a real upload:
 *
 *   key → scope → upload permission → Vercel Private Blob → database
 *
 * The Blob step is a real write/read/delete round trip against a scratch
 * object, and the database step is a real query. Nothing here is mocked, and
 * the endpoint never echoes secret material back to the caller.
 */

interface CheckResult {
  step: string;
  ok: boolean;
  detail: string;
}

export async function POST(request: Request) {
  const response = await apiRoute(request, async (requestId) => {
    const ip = getClientIp(request);
    enforceRateLimit(`v1:auth-test:${ip}`, 20);

    const requestContext = { method: request.method, path: new URL(request.url).pathname, requestId, ip };
    const checks: CheckResult[] = [];

    // 1. Authentication — identical to the upload route.
    let keyId: string;
    let scopes: ApiScope[];
    let authMode: string;
    if (hasBridgeCredentialHeaders(request)) {
      const credential = await requireBridgeCredential(request, requestContext);
      keyId = credential.keyId ?? credential.logKey;
      scopes = credential.scopes;
      authMode = credential.mode === "legacy" ? "legacy-header" : "key-id+secret";
    } else {
      const token = bearerTokenFrom(request);
      if (!token) {
        logger.warn("API key authentication failed", { reason: "missing_headers", ...requestContext });
        throw new ApiError(401, "INVALID_API_KEY", "Missing or invalid API credential. Send X-AM-Storage-Key-Id with X-AM-Storage-Key-Secret, or Authorization: Bearer <secret>.");
      }
      const verified = await verifyBearerKeySafely(token, requestContext);
      if (!verified) {
        logger.warn("API key authentication failed", { reason: "bad_bearer_token", ...requestContext });
        throw new ApiError(401, "INVALID_API_KEY", "Missing or invalid API credential. Send X-AM-Storage-Key-Id with X-AM-Storage-Key-Secret, or Authorization: Bearer <secret>.");
      }
      keyId = verified.keyId;
      scopes = verified.scopes;
      authMode = "bearer";
    }
    checks.push({ step: "authentication", ok: true, detail: `Key ${keyId} authenticated via ${authMode}.` });

    // 2. Scope resolution.
    checks.push({ step: "scopes", ok: true, detail: `Granted: ${scopes.length ? scopes.join(", ") : "none"}.` });

    // 3. Upload permission.
    const canUpload = scopes.includes("files:upload");
    checks.push({
      step: "upload_permission",
      ok: canUpload,
      detail: canUpload ? "The key holds files:upload." : "The key is missing the required scope: files:upload.",
    });

    // 4. Vercel Private Blob round trip (only when the key may actually upload).
    const blobConfig = readBlobStoreConfig();
    if (!canUpload) {
      checks.push({ step: "vercel_blob", ok: false, detail: "Skipped: the key cannot upload." });
    } else if (!blobConfig.ok) {
      checks.push({ step: "vercel_blob", ok: false, detail: blobConfig.error ?? "Blob storage is not configured." });
    } else {
      const probeKey = `health/api-key-test-${crypto.randomUUID()}.pdf`;
      const probeBytes = new TextEncoder().encode("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
      const storage = getStorageService();
      try {
        await storage.upload({ pathname: probeKey, body: probeBytes, contentType: "application/pdf", contentLength: probeBytes.byteLength });
        const metadata = await storage.getMetadata(probeKey);
        const sizeMatches = metadata.contentLength === probeBytes.byteLength;
        checks.push({
          step: "vercel_blob",
          ok: sizeMatches,
          detail: sizeMatches
            ? `Wrote, verified and removed a ${probeBytes.byteLength}-byte probe object (auth mode: ${blobConfig.authMode}).`
            : "The probe object could not be verified in the store.",
        });
      } catch (error) {
        checks.push({
          step: "vercel_blob",
          ok: false,
          detail: error instanceof ApiError ? error.message : "The private Blob store could not be reached.",
        });
      } finally {
        try { await storage.delete(probeKey); } catch { /* best-effort probe cleanup */ }
      }
    }

    // 5. Database metadata reachability.
    try {
      const result = await query<{ total: number }>(`SELECT count(*) AS total FROM files WHERE status = 'active'`);
      checks.push({ step: "database", ok: true, detail: `Metadata store reachable (${Number(result.rows[0]?.total ?? 0)} active files).` });
    } catch {
      checks.push({ step: "database", ok: false, detail: "The metadata database is temporarily unavailable." });
    }

    const ok = checks.every((check) => check.ok);
    logger.info("API key self-test completed", { requestId, keyId, ok });

    return NextResponse.json(
      {
        success: true,
        data: {
          ok,
          keyId,
          authMode,
          scopes,
          availableScopes: [...API_SCOPES],
          checks,
        },
        requestId,
      },
      { status: 200, headers: { "X-Request-Id": requestId, "Cache-Control": "no-store" } },
    );
  }, { route: "v1/auth/test" });

  return withBridgeCors(response, request);
}

export async function OPTIONS(request: Request) {
  return bridgePreflightResponse(request);
}
