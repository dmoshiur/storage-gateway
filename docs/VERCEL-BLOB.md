# Vercel Private Blob: configuration, diagnostics, and verification

The application stores document bytes **only** in a private Vercel Blob store and keeps
metadata in Turso/libSQL. If the application reports *"Blob unavailable"*, this page tells
you exactly which variable or permission is missing and how to prove the pipeline works
with a real PDF.

## 1. How authentication actually works

Vercel Blob authentication is resolved in this order:

| Mode | What is present | What the server uses |
| --- | --- | --- |
| `token` | `BLOB_READ_WRITE_TOKEN` | Static read-write token (legacy stores, or local development against a real store). |
| `oidc` | `BLOB_STORE_ID` (plus `BLOB_WEBHOOK_PUBLIC_KEY` for upload callbacks) | A short-lived OIDC token that the **Vercel runtime delivers per request** on the `x-vercel-oidc-token` header. The `@vercel/blob` SDK reads and refreshes it automatically. |
| `none` | neither | Every Blob operation fails with `503 BLOB_NOT_CONFIGURED` and the exact list of missing variables. |

Two facts that explain the historical *"Blob unavailable"* failure:

1. `VERCEL_OIDC_TOKEN` is **not** a stored Vercel environment variable. Vercel issues it
   per request for Functions. Requiring it in `process.env` makes a correctly connected
   store look unconfigured.
2. Connecting a store adds exactly `BLOB_STORE_ID` and `BLOB_WEBHOOK_PUBLIC_KEY`.
   Nothing else has to be created for OIDC.

Never create `VERCEL_OIDC_TOKEN` by hand and never prefix any Blob variable with
`NEXT_PUBLIC_`. `vercel env pull` writes a local copy only so `npm run dev` can talk to a
real store; that file stays out of Git.

## 2. Verify the store is connected to *this* project

Dashboard (authoritative):

1. Vercel → **Storage** → select the Blob store.
2. Open the **Projects** tab: the production project must be listed and connected to the
   environment you are testing (Production / Preview / Development).
3. If the project is missing, click **Connect Project**. If the store was created before
   OIDC support, use **Upgrade to OIDC**.
4. Redeploy after connecting: the injected variables only exist in new deployments.

CLI (from a checkout linked to the project):

```bash
vercel link
vercel env ls production | grep -E 'BLOB_STORE_ID|BLOB_WEBHOOK_PUBLIC_KEY|BLOB_READ_WRITE_TOKEN'
vercel blob list                    # authenticates through the project's OIDC
```

Application-level proof (works without dashboard access):

```bash
curl -s https://<production-host>/api/v1/health | jq
#   "blobConfigured": true, "blobAuthMode": "oidc", "missingBlobConfig": []
```

and, signed in as an administrator:

```bash
curl -s -b cookie.txt https://<production-host>/api/blob/health | jq
curl -s -b cookie.txt 'https://<production-host>/api/blob/health?deep=true' | jq
```

`GET /api/blob/health` returns the effective auth mode, the exact `BLOB_STORE_ID` in use
(so you can compare it with the dashboard), which variables are present, and — when
something is wrong — the exact `errorCode`, `errorName`, message, and hint.
`?deep=true` additionally performs a real `put → head → get → delete` round-trip on
`health/doctor-<uuid>.pdf` and removes the probe object. Neither endpoint returns a token,
webhook key, or any other secret.

## 3. Error codes you may see

| Code | Meaning | Fix |
| --- | --- | --- |
| `BLOB_NOT_CONFIGURED` | Neither `BLOB_STORE_ID` nor `BLOB_READ_WRITE_TOKEN` is visible to the runtime. | Connect the private store to the project and redeploy, or set `BLOB_READ_WRITE_TOKEN`. |
| `BLOB_OIDC_ENVIRONMENT_NOT_ALLOWED` | OIDC exists, but not for this environment (classic `preview` after enabling OIDC for production only). | Vercel → Storage → store → **Projects** → enable the environment, then redeploy. |
| `BLOB_ACCESS_ERROR` | The credential is valid but the store rejected the operation. | Re-check store/project pairing and that the store is private. |
| `BLOB_STORE_NOT_FOUND` / `BLOB_STORE_SUSPENDED` | `BLOB_STORE_ID` does not resolve, or the store is suspended. | Compare the reported store id with the dashboard; resume the store. |
| `BLOB_WEBHOOK_KEY_MISSING` | `BLOB_WEBHOOK_PUBLIC_KEY` is absent, so signed upload callbacks cannot be verified. | Re-connect the store so Vercel re-injects the key. Uploads still complete through `/api/files/[id]/complete`. |
| `BLOB_SIGNING_FAILED` / `BLOB_SIGNING_TIMEOUT` | The upload route could not mint a presigned PUT token. | The response and server logs carry the real SDK error name and message; fix the underlying configuration. |

## 4. Verify a real PDF on the production deployment

```bash
node scripts/verify-blob.mjs \
  --base-url https://<production-host> \
  --email <admin-email> --password <admin-password>
# or, without a session account:
node scripts/verify-blob.mjs --base-url https://<production-host> --api-key ng_live_...
# or reuse an existing browser session:
node scripts/verify-blob.mjs --base-url https://<production-host> --cookie 'storage_gateway_session=...'
```

The script exercises the complete production path with a real (minimal, valid) PDF:
login → `/api/blob/health` (+`?deep=true`) → `upload/init` → `/api/blob/upload` presign →
`PUT` the PDF bytes to the returned Blob URL → `complete` (server verifies the object with
`head` + range reads and activates the row) → metadata list → byte-for-byte `preview` and
`download` comparison → trash → restore → permanent delete → preview returns `404`.
It exits non-zero if any step fails and prints the exact server error for the failing step.
Use `--keep` to leave the uploaded document in place for manual inspection, and `--pdf`
to upload your own PDF instead of the generated sample.

## 5. Rules this codebase follows

- Documents live in Vercel Private Blob only; the database stores pathnames and metadata.
- No mock, fake, or local-filesystem storage exists in `src/`. Test doubles live under
  `tests/` and are never imported by application code.
- No Blob credential is ever sent to the browser: the browser receives only a short-lived,
  single-path, `put`-scoped presigned URL.
- Real SDK errors are surfaced (status code and error code preserved) instead of being
  replaced with a generic "Blob unavailable" message.
