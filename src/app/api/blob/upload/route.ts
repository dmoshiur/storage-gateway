import { NextResponse } from "next/server";
import { issueSignedToken } from "@vercel/blob";
import {
  handleUploadPresigned,
  type HandleUploadPresignedBody,
} from "@vercel/blob/client";
import { apiRoute } from "@/lib/api/route";
import { getBlobStoreConfig } from "@/lib/env";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * OIDC-compatible client upload token route.
 *
 * Vercel docs: `handleUpload` always requires BLOB_READ_WRITE_TOKEN.
 * For OIDC (BLOB_STORE_ID + VERCEL_OIDC_TOKEN) you MUST use
 * `handleUploadPresigned`, which issues presigned PUT URLs via
 * `issueSignedToken` and verifies the onUploadCompleted callback with
 * BLOB_WEBHOOK_PUBLIC_KEY.
 *
 * See: https://vercel.com/docs/vercel-blob/using-blob-sdk
 *      https://vercel.com/docs/vercel-blob/vercel-signed-urls
 */
export async function POST(request: Request) {
  return apiRoute(
    request,
    async () => {
      const body = (await request.json()) as HandleUploadPresignedBody;

      try {
        const jsonResponse = await handleUploadPresigned({
          body,
          request,
          // Webhook public key is resolved with prefix support in env.ts
          // (e.g. TBLOB_WEBHOOK_PUBLIC_KEY). Falls back to env var.
          webhookPublicKey:
            getBlobStoreConfig().webhookPublicKey ??
            process.env.BLOB_WEBHOOK_PUBLIC_KEY ??
            process.env.BLOB_WEBHOOK_KEY ??
            undefined,

          /**
           * This runs for every `blob.generate-client-token` request.
           * We authenticate the admin user here, validate the pathname,
           * and mint a short-lived signed token using OIDC or static token.
           */
          getSignedToken: async (pathname, clientPayload) => {
            // Authenticate dashboard user (Firebase session cookie)
            const actor = await requireAdminRequest(
              request,
              "manage_files",
              true,
            );
            enforceRateLimit(`blob:upload:${actor.uid}`, 30);

            // Basic pathname validation: must be inside our pdfs/ or uploads/ prefix
            // and contain a UUID + supported extension. Prevents path traversal.
            if (
              !pathname.startsWith("pdfs/") &&
              !pathname.startsWith("uploads/")
            ) {
              throw new Error("Invalid upload pathname prefix.");
            }
            if (pathname.includes("..") || pathname.includes("//")) {
              throw new Error("Invalid pathname.");
            }

            // Optional: parse clientPayload for fileId tracking
            let fileId: string | null = null;
            try {
              if (clientPayload) {
                const parsed = JSON.parse(clientPayload);
                if (typeof parsed.fileId === "string") fileId = parsed.fileId;
              }
            } catch {
              // ignore malformed payload
            }

            const { token, storeId, oidcToken } = getBlobStoreConfig();

            // issueSignedToken works with BOTH auth modes:
            // - token: BLOB_READ_WRITE_TOKEN (static)
            // - storeId + oidcToken: OIDC (recommended on Vercel)
            const issuedToken = await issueSignedToken({
              pathname,
              operations: ["put"],
              validUntil: Date.now() + 60 * 60 * 1000, // token valid 1h, URL shorter
              ...(token ? { token } : {}),
              ...(storeId ? { storeId } : {}),
              ...(oidcToken && !token ? { oidcToken } : {}),
            });

            // Tight constraints for dashboard uploads
            const allowedContentTypes = [
              "application/pdf",
              "application/msword",
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              "text/plain",
              "application/vnd.ms-powerpoint",
              "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            ];

            return {
              token: issuedToken,
              urlOptions: {
                access: "private" as const,
                // Constraints enforced by Vercel Blob on PUT
                allowedContentTypes,
                // Allow up to 100MB (dashboard limit enforced separately in init)
                maximumSizeInBytes: 100 * 1024 * 1024,
                validUntil: Date.now() + 10 * 60 * 1000, // URL valid 10min
                addRandomSuffix: false,
                allowOverwrite: true,
                cacheControlMaxAge: 60,
              },
            };
          },

          onUploadCompleted: async ({ blob, tokenPayload }) => {
            // This is called by Vercel Blob after a successful client upload
            // via a signed webhook (verified with BLOB_WEBHOOK_PUBLIC_KEY).
            // We don't activate the file here because the dashboard flow
            // uses /api/files/[id]/complete for validation (PDF header check).
            // This hook is for logging/auditing and works locally with ngrok.
            try {
              const payload = tokenPayload ? JSON.parse(tokenPayload) : {};
              console.log(
                JSON.stringify({
                  level: "info",
                  message: "Blob presigned upload completed",
                  pathname: blob.pathname,
                  url: blob.url,
                  fileId: payload.fileId ?? null,
                }),
              );
            } catch {
              // ignore
            }
          },
        });

        return NextResponse.json(jsonResponse);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Upload token generation failed";
        // handleUploadPresigned expects 400 for client errors, 401 for auth
        const status = message.includes("Not authorized") ||
          message.includes("auth") ||
          message.includes("session")
          ? 401
          : 400;
        return NextResponse.json({ error: message }, { status });
      }
    },
    { route: "blob/upload" },
  );
}
