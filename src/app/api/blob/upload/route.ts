import { NextResponse } from "next/server";
import { z } from "zod";
import { issueSignedToken, presignUrl, type PresignedUrlPayload } from "@vercel/blob";
import {
  handleUploadPresigned,
  type HandleUploadPresignedBody,
} from "@vercel/blob/client";
import { ApiError } from "@/lib/api/errors";
import { parseJson } from "@/lib/api/body";
import { apiRoute } from "@/lib/api/route";
import { getBlobStoreConfig } from "@/lib/env";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * OIDC-compatible client upload token route (fixes the "Uploading… 0%" hang).
 *
 * Flow used by the dashboard (`uploadPresigned` from @vercel/blob/client):
 *   1. Client POSTs `{ type: "blob.generate-presigned-url", payload: { pathname, … } }`.
 *   2. We authenticate the session, validate the pathname, and mint a signed
 *      delegation via `issueSignedToken` — this works with BOTH auth modes:
 *      static `BLOB_READ_WRITE_TOKEN` and OIDC (`BLOB_STORE_ID` +
 *      `VERCEL_OIDC_TOKEN`).
 *   3. We return `{ type, presignedUrlPayload }`; the client then PUTs the
 *      bytes directly to https://vercel.com/api/blob (must be allowed by the
 *      CSP connect-src — see next.config.ts).
 *   4. Completion is verified by the client via /api/files/[id]/complete, so
 *      the webhook callback is optional (only used for audit logging when
 *      BLOB_WEBHOOK_PUBLIC_KEY is configured).
 *
 * Anti-hang guarantees (the previous version could wedge forever):
 *   - `issueSignedToken` is bounded by an AbortController + timeout (504).
 *   - The whole handler is bounded by a route-level race timeout (504), so
 *     this route ALWAYS responds and never spins.
 *   - Auth and input validation happen BEFORE any network I/O, so bad
 *     requests fail in milliseconds with 400/401/403/429.
 *   - When BLOB_WEBHOOK_PUBLIC_KEY is absent we fall back to signing with
 *     `presignUrl` directly instead of hard-failing inside the SDK helper.
 */

const EVENT_TOKEN = "blob.generate-presigned-url";
const EVENT_COMPLETED = "blob.upload-completed";
const MAX_PATHNAME_LENGTH = 950;
const ALLOWED_PATHNAME_PREFIXES = ["pdfs/", "uploads/"];
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const DELEGATION_VALIDITY_MS = 60 * 60 * 1000; // signed token lives 1h
const URL_VALIDITY_MS = 10 * 60 * 1000; // presigned URL lives 10min

const ALLOWED_CONTENT_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
];

/** Timeouts are env-overridable so tests can run them in milliseconds. */
function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
const SIGNING_TIMEOUT_MS = positiveIntEnv("BLOB_UPLOAD_SIGNING_TIMEOUT_MS", 10_000);
const ROUTE_TIMEOUT_MS = positiveIntEnv("BLOB_UPLOAD_ROUTE_TIMEOUT_MS", 20_000);

const tokenEventSchema = z.object({
  type: z.literal(EVENT_TOKEN),
  payload: z
    .object({
      pathname: z.string().min(1).max(MAX_PATHNAME_LENGTH),
      clientPayload: z.string().nullable().optional(),
      multipart: z.boolean().optional(),
    })
    .passthrough(),
});

const completedEventSchema = z.object({
  type: z.literal(EVENT_COMPLETED),
  payload: z
    .object({
      blob: z.unknown(),
      tokenPayload: z.string().nullable().optional(),
    })
    .passthrough(),
});

const eventSchema = z.discriminatedUnion("type", [tokenEventSchema, completedEventSchema]);

/** Race any pending work against a hard deadline so the route always responds. */
async function withRouteTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new ApiError(
            504,
            "UPLOAD_TOKEN_TIMEOUT",
            "Generating the direct-upload token took too long. The Vercel Blob API did not respond in time — please retry.",
          ),
        ),
      ROUTE_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([work, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function assertUploadPathname(pathname: string): void {
  if (pathname.startsWith("/") || pathname.includes("..") || pathname.includes("//")) {
    throw new ApiError(400, "INVALID_UPLOAD_PATH", "The upload destination path is invalid.");
  }
  if (!ALLOWED_PATHNAME_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    throw new ApiError(400, "INVALID_UPLOAD_PATH", "The upload destination path is not allowed.");
  }
}

/**
 * Mint the put-scoped delegation token. Works with OIDC
 * (storeId + oidcToken) or a static read-write token, and is abort-bounded so
 * a stalled Vercel API exchange fails fast instead of hanging the route.
 */
async function signPutDelegationToken(pathname: string) {
  const { token, storeId, oidcToken } = getBlobStoreConfig(); // throws 503 when unconfigured
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SIGNING_TIMEOUT_MS);
  try {
    return await issueSignedToken({
      pathname,
      operations: ["put"],
      validUntil: Date.now() + DELEGATION_VALIDITY_MS,
      allowedContentTypes: ALLOWED_CONTENT_TYPES,
      maximumSizeInBytes: MAX_UPLOAD_BYTES,
      ...(token ? { token } : {}),
      ...(storeId ? { storeId } : {}),
      ...(oidcToken && !token ? { oidcToken } : {}),
      abortSignal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ApiError(
        504,
        "BLOB_SIGNING_TIMEOUT",
        "Signing the upload token timed out. The Vercel Blob API (/signed-token) did not respond — please retry.",
      );
    }
    // Surface OIDC/token misconfiguration with an actionable message.
    throw new ApiError(
      502,
      "BLOB_SIGNING_FAILED",
      `Signing the upload token failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Rebuild the `presignedUrlPayload` the SDK client expects from a presigned
 * URL produced by `presignUrl`. The wire format is fully deterministic:
 * delegation + signature + vercel-blob-* params in the query string.
 */
function payloadFromPresignedUrl(presignedUrl: string): PresignedUrlPayload {
  const url = new URL(presignedUrl);
  const params: Record<string, string> = {};
  let delegationToken = "";
  let signature = "";
  for (const [key, value] of url.searchParams.entries()) {
    if (key === "vercel-blob-delegation") delegationToken = value;
    else if (key === "vercel-blob-signature") signature = value;
    else if (key.startsWith("vercel-blob-")) params[key] = value;
  }
  if (!delegationToken || !signature) {
    throw new ApiError(502, "BLOB_PRESIGN_FAILED", "The presigned upload URL could not be built.");
  }
  return { delegationToken, signature, params };
}

/** Audit-log webhook completions (signature is verified by the SDK before this runs). */
async function logUploadCompleted(payload: {
  blob: { pathname?: string; url?: string };
  tokenPayload?: string | null;
}): Promise<void> {
  try {
    const parsed = payload.tokenPayload ? JSON.parse(payload.tokenPayload) : {};
    console.log(
      JSON.stringify({
        level: "info",
        message: "Blob presigned upload completed",
        pathname: payload.blob?.pathname ?? null,
        url: payload.blob?.url ?? null,
        fileId: typeof parsed.fileId === "string" ? parsed.fileId : null,
      }),
    );
  } catch {
    // logging must never break the webhook response
  }
}

function resolveWebhookPublicKey(): string | null {
  return (
    getBlobStoreConfig().webhookPublicKey ??
    process.env.BLOB_WEBHOOK_PUBLIC_KEY ??
    process.env.BLOB_WEBHOOK_KEY ??
    null
  );
}

export async function POST(request: Request) {
  return apiRoute(
    request,
    async () => {
      // 1) Parse + validate the SDK event strictly, before touching the network.
      const event = await parseJson(request, eventSchema);

      // 2) Webhook completion callbacks are authenticated by Ed25519 signature
      //    (verified inside handleUploadPresigned) — never by session cookie.
      if (event.type === EVENT_COMPLETED) {
        const webhookPublicKey = resolveWebhookPublicKey();
        if (!webhookPublicKey) {
          throw new ApiError(
            501,
            "WEBHOOK_NOT_CONFIGURED",
            "Upload completion callbacks require BLOB_WEBHOOK_PUBLIC_KEY. Uploads still work; completion is verified via /api/files/[id]/complete.",
          );
        }
        const result = await withRouteTimeout(
          handleUploadPresigned({
            body: event as unknown as HandleUploadPresignedBody,
            request,
            webhookPublicKey,
            getSignedToken: async () => {
              // Token issuance is never requested on the completed-event branch.
              throw new ApiError(400, "INVALID_EVENT", "Unexpected token request.");
            },
            onUploadCompleted: logUploadCompleted,
          }),
        );
        return NextResponse.json(result);
      }

      // 3) Token issuance: authenticate + rate limit FIRST (fail fast, no I/O).
      const actor = await requireAdminRequest(request, "manage_files", true);
      enforceRateLimit(`blob:upload:${actor.uid}`, 30);

      const { pathname, multipart } = event.payload;
      assertUploadPathname(pathname);
      if (multipart) {
        throw new ApiError(
          400,
          "MULTIPART_NOT_SUPPORTED",
          "Multipart uploads are not enabled for dashboard uploads.",
        );
      }

      const webhookPublicKey = resolveWebhookPublicKey();

      const presignedUrlPayload = await withRouteTimeout(
        (async () => {
          if (webhookPublicKey) {
            // Preferred path: the SDK helper wires the (optional) completion
            // callback and returns the payload in the exact client shape.
            const result = await handleUploadPresigned({
              body: event as unknown as HandleUploadPresignedBody,
              request,
              webhookPublicKey,
              getSignedToken: async () => ({
                token: await signPutDelegationToken(pathname),
                urlOptions: {
                  allowedContentTypes: ALLOWED_CONTENT_TYPES,
                  maximumSizeInBytes: MAX_UPLOAD_BYTES,
                  validUntil: Date.now() + URL_VALIDITY_MS,
                  addRandomSuffix: false,
                  allowOverwrite: true,
                  cacheControlMaxAge: 60,
                },
              }),
              onUploadCompleted: logUploadCompleted,
            });
            if (result.type !== EVENT_TOKEN) {
              throw new ApiError(500, "UPLOAD_TOKEN_FAILED", "Unexpected response while signing the upload token.");
            }
            return result.presignedUrlPayload;
          }

          // Fallback (no BLOB_WEBHOOK_PUBLIC_KEY configured): sign + presign
          // directly. The dashboard flow does not need the webhook — completion
          // is validated by /api/files/[id]/complete — so refusing to mint
          // tokens without a webhook key would needlessly break uploads.
          const signed = await signPutDelegationToken(pathname);
          const { presignedUrl } = await presignUrl(signed, {
            operation: "put",
            pathname,
            validUntil: Date.now() + URL_VALIDITY_MS,
            allowedContentTypes: ALLOWED_CONTENT_TYPES,
            maximumSizeInBytes: MAX_UPLOAD_BYTES,
            addRandomSuffix: false,
            allowOverwrite: true,
            cacheControlMaxAge: 60,
            access: "private",
          });
          return payloadFromPresignedUrl(presignedUrl);
        })(),
      );

      // Exact shape the @vercel/blob client parses (presignedUrlPayload).
      return NextResponse.json({ type: EVENT_TOKEN, presignedUrlPayload });
    },
    { route: "blob/upload" },
  );
}
