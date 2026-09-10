# AM Storage Company — Storage Gateway API

Base URL examples below use `https://storage.example.org`. All responses are JSON unless `redirect=true` is explicitly requested.

```json
{ "success": true, "data": {}, "requestId": "uuid" }
```

Errors use the same stable envelope and never return internal stack traces:

```json
{
  "success": false,
  "error": {
    "code": "FILE_NOT_FOUND",
    "message": "The requested document was not found."
  },
  "requestId": "uuid"
}
```

Save `requestId` when reporting an issue. API responses use `Cache-Control: no-store`.

## Authentication modes

### Admin dashboard API

The admin browser signs in one of two ways: the shared `ADMIN_PASS` passphrase at `POST /api/auth/pass` (full administrator, no Firebase account), or Firebase email/password exchanged for a server-verified session cookie at `POST /api/auth/session`. Every dashboard route requires that verified cookie and enforces the actor role; mutation routes additionally require a same-origin request.

Never construct an admin-only request based on a browser-side `isAdmin` value.

### NGO website integration API

The NGO main website ([gramunnayan.com](https://gramunnayan.com)) has two
integration modes:

1. **Recommended — through the AM Storage Bridge (FastAPI).** The public bridge
   endpoint `POST /api/v1/storage/upload` accepts multipart PDF, DOC, DOCX,
   TXT, PPT, and PPTX documents authenticated with a **dual-token credential**
   generated in the dashboard (**Admin → API Management**): a visible
   **API Key ID** (`am_store_live_…`) plus an **API Secret Key**
   (`am_sec_live_…`, displayed exactly once, Cloudflare R2 style). The bridge
   validates the credential against the registry, streams the document into
   private R2, registers it, and returns a signed document URL. It also exposes
   credential-protected `GET /api/files`,
   `GET /api/files/{id}` and `GET /api/files/{id}/download`. See
   `fastapi/README.md`.

   Three credential forms are accepted (in priority order):

   ```http
   # a) Dual-token (recommended)
   X-AM-Storage-Key-Id: am_store_live_xxxxxx
   X-AM-Storage-Key-Secret: am_sec_live_yyyyyy

   # b) HMAC signed (secret is never sent after setup; replay-protected by
   #    the 5-minute timestamp window). signature = HMAC-SHA256(
   #    keySecret, "<timestamp>:<sha256hex(raw body bytes)>") in lowercase hex.
   X-AM-Storage-Key-Id: am_store_live_xxxxxx
   X-AM-Storage-Timestamp: 1788888888
   X-AM-Storage-Signature: <64-char hex>

   # c) Legacy single key (pre-upgrade integrations, rotate to dual-token)
   X-AM-Storage-Key: am_store_live_zzzzzz
   ```

   Signed mode requires the gateway to have `AM_STORAGE_MASTER_KEY` configured
   (the secret is then stored AES-256-GCM encrypted so HMACs can be verified
   without persisting plaintext). Revocation takes effect on the next request.

   > **`POST /api/v1/storage/upload` is owned by the FastAPI bridge, not by
   > this Next.js gateway.** The gateway offers an optional compatibility proxy
   > at `/api/v1/storage/upload` that streams the upload to the configured
   > `BRIDGE_URL` / `NEXT_PUBLIC_BRIDGE_URL` origin. When no bridge origin is
   > configured, the gateway returns a JSON 404
   > (`BRIDGE_ENDPOINT_NOT_AT_GATEWAY`) instead of an HTML page. Point
   > `AM_STORAGE_BRIDGE_URL` on the integration server at the bridge origin; if
   > the integration must call the gateway host, set the gateway's
   > `BRIDGE_URL` / `NEXT_PUBLIC_BRIDGE_URL` to the FastAPI bridge origin so the
   > proxy can forward the upload.

2. **Direct read-only gateway access** from the NGO server's own backend with:

   ```http
   X-Storage-Gateway-Key: <INTEGRATION_API_KEY>
   ```

This integration key must never be sent to the NGO website browser, committed to source, logged, or put in `NEXT_PUBLIC_*`. An integration caller can access active, non-expired metadata and request a short-lived download URL. It cannot access Trash, settings, logs, uploads, or any destructive endpoint.

## Admin auth

### `POST /api/auth/pass`

Sign in the shared administrator with the environment passphrase alone. Requires a same-origin request and is rate limited per client IP.

**Body**

```json
{ "adminPass": "shared-passphrase" }
```

**Success `200`**

```json
{
  "success": true,
  "data": {
    "actor": { "uid": "shared-pass-admin", "email": null, "role": "admin" }
  }
}
```

Sets the HTTP-only session cookie holding an HMAC-signed shared-pass session with full administrator access. Rotating `ADMIN_PASS` invalidates every shared-pass session. `401 ADMIN_PASS_INVALID` is returned for a wrong passphrase.

### `POST /api/auth/session`

Exchange a Firebase ID token for a server-verified session cookie.

**Body**

```json
{ "idToken": "firebase-id-token" }
```

**Success `200`**

```json
{
  "success": true,
  "data": {
    "actor": { "uid": "firebase-uid", "email": "admin@example.org", "role": "admin" }
  }
}
```

`401` is returned for an invalid/revoked ID token. Any user created in Firebase Authentication may sign in; the resolved role (`admin` custom claim, `ADMIN_EMAILS` bootstrap, else `viewer`) decides route-level capabilities, with `editor`/`viewer` limited to read-only access.

### `POST /api/auth/logout`

Clears the session cookie and writes a `LOGOUT` audit event when a session exists. Requires same-origin browser context.

### `GET /api/auth/me`

Returns the currently verified actor. Requires a valid session.

## File API

### `GET /api/files`

List document metadata using cursor pagination.

**Admin session query parameters**

| Parameter | Values / default |
| --- | --- |
| `pageSize` | `1..100`, default `25` |
| `cursor` | opaque cursor returned by a prior call |
| `status` | `active` default; `all`, `trash`, `deleted`, `uploading`, `deleting`, `failed` |
| `filter` | `all`, `active`, `trash`, `auto_delete`, `never_delete`, `expiring_soon`, `expired` |
| `sort` | `newest` default, `oldest`, `largest`, `smallest`, `delete_date` |
| `search` | up to 100 characters; searches filename/title/description/category/tags |

Text search and relative-date filters use a bounded server-side scan (1,000 matching records) rather than exposing all records to the browser. `searchLimited: true` signals that a narrower search is needed.

**Success `200`**

```json
{
  "success": true,
  "data": {
    "files": [
      {
        "id": "abc123...",
        "originalName": "annual-report-2025.pdf",
        "title": "Annual Report 2025",
        "description": "Annual report of the NGO",
        "category": "Reports",
        "tags": ["annual", "report"],
        "mimeType": "application/pdf",
        "extension": "pdf",
        "size": 5242880,
        "createdAt": "2026-09-09T11:30:00.000Z",
        "autoDeleteEnabled": true,
        "retentionType": "6_months",
        "deleteAt": "2027-03-09T11:30:00.000Z",
        "status": "active"
      }
    ],
    "nextCursor": "opaque-or-null",
    "searchLimited": false
  }
}
```

`storageKey`, R2 bucket details, staging keys, and credentials are never returned.

**Integration behavior:** status is forced to `active`; expired retention records and non-active lifecycle states are never returned.

### `GET /api/files/:id`

Return one metadata record. Admin callers can read active or Trash records; integration callers receive only active, non-expired records.

- `404 FILE_NOT_FOUND` for hidden, deleted, failed, uploading, or unavailable records.

### `POST /api/files/upload/init` (admin only)

`POST /api/files/upload` is a compatibility alias for this upload-authorization step. Both routes return the same direct-to-R2 upload contract; neither accepts raw document bytes.

Authorize a direct, short-lived staging upload. The document payload itself does **not** pass through this API or Vercel.

**Body**

```json
{
  "originalName": "annual-report-2025.pdf",
  "size": 5242880,
  "mimeType": "application/pdf",
  "title": "Annual Report 2025",
  "description": "Annual report of the NGO",
  "category": "Reports",
  "tags": ["annual", "report"],
  "retention": {
    "autoDeleteEnabled": true,
    "retentionType": "6_months",
    "customDeleteAt": null
  }
}
```

`retention` is optional; when omitted, the server uses current global defaults. `customDeleteAt` is required as `YYYY-MM-DD` only when `retentionType` is `custom_date`.

The server validates a supported `.pdf/.doc/.docx/.txt/.ppt/.pptx` extension, a positive declared byte size, configurable max size, and configured storage capacity before it returns a signed upload URL.

**Success `201`**

```json
{
  "success": true,
  "data": {
    "file": { "id": "generated-id", "status": "uploading" },
    "uploadUrl": "https://...short-lived-signed-r2-put-url...",
    "uploadHeaders": {
      "Content-Type": "application/pdf",
      "x-amz-meta-file-id": "generated-id"
    },
    "expiresAt": "2026-09-09T11:40:00.000Z"
  }
}
```

Upload the raw bytes with `PUT` and exactly the returned headers, then call completion. Configure R2 CORS as described in `docs/SETUP.md`.

### `POST /api/files/:id/complete` (admin only)

Finalize a staging upload after the direct R2 `PUT` returns success. Send `{}` as the JSON body.

The server heads/range-reads the private staging object and checks:

- supported document extension;
- exact declared versus actual byte size;
- expected content type (`application/pdf`, Word/PowerPoint MIME types, `text/plain`);
- signed `x-amz-meta-file-id` ownership marker;
- type-specific magic bytes: `%PDF-1.x` + `%%EOF` for PDF, OLE2 for DOC/PPT, ZIP for DOCX/PPTX.

A successful object is copied to a random final `documents/YYYY/MM/uuid.ext` key before Firestore becomes `active`. Invalid objects are marked `failed`, audit logged, and deletion is attempted. Retry a transient `STORAGE_UNAVAILABLE` completion; the lifecycle is intentionally idempotent.

### `PATCH /api/files/:id` (admin only)

Update searchable metadata and/or file-specific retention.

```json
{
  "title": "Annual Report 2025 (approved)",
  "description": "Approved final report",
  "category": "Reports",
  "tags": ["annual", "approved"],
  "retention": {
    "autoDeleteEnabled": true,
    "retentionType": "1_year",
    "customDeleteAt": null
  }
}
```

At least one supported field is required. Retention dates are calculated using the server clock. Successful metadata/retention changes create audit records.

### `DELETE /api/files/:id` (admin only)

Moves an **active** document to Trash. This is a soft deletion: its private R2 object remains available for recovery until `permanentDeleteAt`. The route requires an explicit server-side confirmation body in addition to the dashboard’s accessible custom confirmation dialog:

```json
{ "confirmation": "MOVE_TO_TRASH" }
```

**Success `200`** returns the record with `status: "trash"` and a scheduled permanent deletion timestamp.

### `POST /api/files/:id/restore` (admin only)

Restores a Trash document to active state if the private object still exists. If elapsed date-based retention would immediately re-expire, server-side calendar policies are recalculated; an expired custom date is reset to Never (automatic deletion off) so an administrator can deliberately choose a new policy.

- `409 FILE_CONTENT_UNAVAILABLE` means the private object has already gone and cannot be restored.

### `POST /api/files/:id/permanent-delete` (admin only)

Permanently removes a Trash object. The body must contain an exact server-side confirmation:

```json
{ "confirmation": "DELETE" }
```

The gateway first moves metadata through `deleting`, then deletes the R2 object, and only then marks the record `deleted`. R2 deletion failures return `502 DELETE_FAILED` and metadata returns to Trash for retry when possible. If Firestore completion is interrupted, the record remains `deleting` and is safely retried by cleanup because S3 delete is idempotent.

### `GET /api/files/:id/download`

Generate a configurable short-lived R2 `GET` URL. Both admin sessions and website integration keys can call this for permitted active documents.

| Query | Default | Meaning |
| --- | --- | --- |
| `disposition` | `attachment` | `attachment` or `inline` |
| `redirect` | `false` | use `true` only for a browser navigation to redirect directly to R2 |

**JSON success (`redirect=false`)**

```json
{
  "success": true,
  "data": {
    "url": "https://...temporary-signed-r2-get-url...",
    "expiresAt": "2026-09-09T11:40:00.000Z",
    "disposition": "inline"
  }
}
```

When `redirect=true`, the gateway returns `302 Location: <temporary signed URL>` with `Cache-Control: no-store`. Download events are audit logged. The bucket itself remains private and no permanent URL is exposed.

## Storage, settings, and audit API

### `GET /api/storage` (admin only)

Returns metadata-based counts and capacity information, the result of the
initial Cloudflare R2 bucket connectivity check, and the accumulated API
request totals from gramunnayan.com:

```json
{
  "stats": {
    "totalPdfCount": 347,
    "activeFileCount": 335,
    "trashFileCount": 12,
    "totalStorageBytes": 8804682957,
    "storageLimitBytes": 10737418240,
    "activeStorageBytes": 8000000000,
    "trashStorageBytes": 804682957,
    "availableBytes": 1932735283,
    "usagePercent": 82,
    "warningLevel": "warning",
    "expiringSoonCount": 5
  },
  "source": "live",
  "r2": { "reachable": true, "latencyMs": 24, "checkedAt": "2026-09-09T11:40:00.000Z" },
  "apiRequests": { "totalRequests": 1287, "lastRequestDate": "2026-09-09" }
}
```

`source` is `"live"` when `stats` were computed from Firestore metadata and
`"fallback"` when Firestore was unreachable — in that case `stats` contains
documented mock metrics (`totalPdfCount: 0`, `totalStorageBytes: 0`, i.e.
"0 files, 0 KB used") so the dashboard always renders. The R2 `HeadBucket`
probe is bounded (3 s) and wrapped: any failure resolves to
`r2.reachable: false` instead of an error response. This route therefore
returns `200` for all degraded-dependency states; only authentication
failures produce `4xx`.

### `GET /api/health` (admin only)

Dashboard system health: gateway runtime plus a live probe of the FastAPI
bridge (`GET <BRIDGE_URL>/health`, bounded 4 s). The probe never throws; it
degrades to `bridge.reachable: false`.

```json
{
  "systemStatus": "operational",
  "gateway": { "runtime": "nodejs", "uptimeSeconds": 3600, "checkedAt": "2026-09-09T11:40:00.000Z" },
  "bridge": { "configured": true, "reachable": true, "latencyMs": 31, "version": "3.1.0", "checkedAt": "2026-09-09T11:40:00.000Z" }
}
```

`systemStatus` is `"operational"` when the bridge is reachable (or no bridge
origin is configured for this deployment) and `"degraded"` when a configured
bridge does not answer.

### `GET /api/api-logs` (admin only)

Recent API (bridge) upload attempts for the dashboard's "API Upload Activity"
widget. Query: `limit` (`1..50`, default `5`). The bridge records both
successful and rejected attempts, so failures carry their `failureCode`.

```json
{
  "logs": [
    {
      "id": "…",
      "keyId": "am_store_live_xxxxxx",
      "filename": "annual-report.pdf",
      "sizeBytes": 432100,
      "status": "success",
      "failureCode": null,
      "requestId": "…",
      "timestamp": "2026-09-09T11:41:02.000Z"
    }
  ]
}
```

### `GET /api/settings` (admin only)

Returns the current settings (or documented safe defaults if `settings/app` has not yet been persisted).

### `PATCH /api/settings` (admin only)

All fields below are required to avoid accidental partial/implicit changes:

```json
{
  "maxPdfSizeBytes": 52428800,
  "storageLimitBytes": 10737418240,
  "defaultAutoDelete": false,
  "defaultRetentionType": "6_months",
  "trashEnabled": true,
  "trashRetentionDays": 30,
  "signedUrlExpirySeconds": 600,
  "warningThresholdPercent": 80,
  "criticalThresholdPercent": 90,
  "applyToExisting": false
}
```

`criticalThresholdPercent` must exceed `warningThresholdPercent`. `applyToExisting` is false by default; when true, all active files explicitly receive the selected default policy and new server-calculated dates. The change is audit logged.

### `GET /api/audit-logs` (admin only)

Query: `pageSize` (`1..100`, default `50`) and optional opaque `cursor`.

Returns sorted audit records such as `LOGIN`, `UPLOAD`, `DOWNLOAD`, `UPDATE_METADATA`, `CHANGE_RETENTION`, `MOVE_TO_TRASH`, `RESTORE`, `PERMANENT_DELETE`, `AUTO_DELETE`, `SETTINGS_CHANGE`, and `CLEANUP_FAILURE`. Logs intentionally exclude passwords, tokens, secrets, signed URLs, and document contents.

### `POST /api/cleanup` (admin only)

Runs the same cleanup process as cron through a verified admin session. It is rate-limited to five requests per administrator per hour and returns a summary:

```json
{
  "checked": 25,
  "movedToTrash": 21,
  "permanentlyDeleted": 2,
  "staleUploadsRemoved": 1,
  "failed": 1,
  "skipped": 3,
  "lockAcquired": true,
  "dryRun": false
}
```

## Scheduler endpoint

### `GET|POST /api/cron/cleanup`

This endpoint is intentionally **not** session- or public-key authenticated. Only a scheduler with the secret may call it:

```http
Authorization: Bearer <CRON_SECRET>
```

Optional query: `dryRun=true` performs no mutations and is useful for a controlled scheduler smoke test.

A concurrent job returns `202` with `lockAcquired: false`; it does not run duplicate deletion work.

## Website integration example

This must run on the NGO website’s **server**, for example a Next.js Route Handler or server component — never in a client component:

```ts
// NGO main website server-only module
const gateway = process.env.DOCUMENT_GATEWAY_URL!;
const key = process.env.DOCUMENT_GATEWAY_INTEGRATION_KEY!;

export async function listNgoReports() {
  const response = await fetch(`${gateway}/api/files?search=report&pageSize=25`, {
    headers: { "X-Storage-Gateway-Key": key },
    cache: "no-store",
  });
  if (!response.ok) throw new Error("The document gateway is unavailable.");
  const payload = await response.json();
  return payload.data.files;
}

export async function getDocumentDownloadUrl(fileId: string) {
  const response = await fetch(`${gateway}/api/files/${encodeURIComponent(fileId)}/download?disposition=inline`, {
    headers: { "X-Storage-Gateway-Key": key },
    cache: "no-store",
  });
  if (!response.ok) return null;
  const payload = await response.json();
  return payload.data.url; // temporary only; do not persist it
}
```

If the public website itself serves visitors, add its own authorization rules before it calls the gateway. A gateway integration key grants the NGO website server access to all active metadata, so it must be kept server-side and scoped operationally.

## Storage Bridge internal endpoints

These routes are **server-to-server only** and must never be called from a
browser. They authenticate with the `X-Storage-Gateway-Key` header (the same
`INTEGRATION_API_KEY` the bridge holds) and back the FastAPI bridge:

### `POST /api/internal/bridge/verify-key`

Accepts one of three payloads (verified against the Firestore registry):

```json
{ "key": "am_store_live_…" }
```

```json
{ "mode": "dual_token", "keyId": "am_store_live_…", "secret": "am_sec_live_…" }
```

```json
{ "mode": "signature", "keyId": "am_store_live_…", "timestamp": 1788888888, "signature": "<64-char hex>", "bodyHash": "<sha256hex of raw body>" }
```

Dual-token mode performs a constant-time SHA-256 digest comparison. Signature
mode decrypts the stored secret (AES-256-GCM, requires `AM_STORAGE_MASTER_KEY`),
recomputes `HMAC-SHA256(secret, "<timestamp>:<bodyHash>")` in constant time,
and rejects timestamps outside the ±5-minute skew window (replay protection).
A successful check refreshes `lastUsedAt` and increments the per-day request
counter shown on the dashboard. Responds `200` with
`{ "valid": true, "keyId": "…" }` or `{ "valid": false, "keyId": null }` —
transport/upstream failures raise `5xx`, never a false rejection.

### `POST /api/internal/bridge/upload-logs`

Body: `{ keyId, filename, sizeBytes, status: "success" | "failed", failureCode, requestId, timestamp }`
(ISO-8601 timestamp). Records one bridge upload attempt for the dashboard's
API activity feed and keeps the collection capped at the 50 newest entries.
Responds `200` with `{ "recorded": true }`. The bridge calls this
best-effort — a failure here never changes the upload outcome.

### `POST /api/internal/bridge/files`

Body includes the final R2 object key (`documents/YYYY/MM/<uuid>.pdf|doc|docx|txt|ppt|pptx`),
validated document metadata (`originalName`, optional `title`/`description`/`category`/`tags`,
plus `mimeType`/`extension`), and `size`. Enforces the configured max document size and storage
limit, creates an `active` document, and writes a `BRIDGE_UPLOAD` audit event. Responds `201`
with the serialized file record.

## Common errors

| Status / code | Meaning |
| --- | --- |
| `400 VALIDATION_ERROR` | Input/query/body did not match schema |
| `415 UNSUPPORTED_MEDIA_TYPE` | A JSON control-plane endpoint received a non-JSON body |
| `400 INVALID_FILE_TYPE` / `INVALID_DOCUMENT` | File did not pass document validation |
| `401 UNAUTHENTICATED` / `SESSION_EXPIRED` | Login/session missing or invalid |
| `401 INVALID_INTEGRATION_KEY` | Website key missing/incorrect |
| `401 INVALID_API_KEY` | Bridge credential missing, revoked, unknown, or signature/timestamp invalid |
| `503 KEY_SERVICE_UNAVAILABLE` | Bridge could not reach the key registry |
| `503 SIGNATURE_VERIFICATION_UNAVAILABLE` | HMAC signed mode used but the key was created without a master key |
| `403 ACCOUNT_NOT_PERMITTED` / `FORBIDDEN` | Identity lacks the required server-side role |
| `403 INVALID_ORIGIN` | Cross-origin cookie mutation rejected |
| `404 FILE_NOT_FOUND` | Document does not exist or is intentionally hidden |
| `409 STORAGE_LIMIT_EXCEEDED` | New upload would exceed configured capacity |
| `409 FILE_CONTENT_UNAVAILABLE` | Trash object cannot be recovered |
| `413 FILE_TOO_LARGE` | Exceeds configured document size limit |
| `429 RATE_LIMITED` | Slow down and retry later |
| `502 STORAGE_UNAVAILABLE` / `DELETE_FAILED` | R2 operation needs retry; details are logged server-side |
| `503 SERVICE_CONFIGURATION_ERROR` | Deployment has missing server configuration |
