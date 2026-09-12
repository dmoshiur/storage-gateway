# Storage Gateway API

All JSON responses use this shape:

```json
{ "success": true, "data": {}, "requestId": "..." }
```

Errors use:

```json
{
  "success": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "You do not have permission to perform this action.",
    "requestId": "...",
    "details": { "retryable": false }
  }
}
```

Every request receives an `X-Request-Id` response header. A caller may provide a valid `X-Request-Id`; otherwise the server creates one. Credentials, passwords, private Blob URLs, and storage paths are never logged or serialized to clients.

## Authentication

### Login

`POST /api/auth/login` (alias: `POST /api/auth/session`)

Same-origin JSON body:

```json
{ "email": "admin@example.org", "password": "a-long-password" }
```

On success the server creates a Turso session and sets a secure, HTTP-only, SameSite=Lax `storage_gateway_session` cookie. The session expires after seven days and is checked against account status, expiry, and revocation on every protected request.

### Logout and current actor

- `POST /api/auth/logout` — revoke the current session and clear the cookie.
- `GET /api/auth/me` — return the authenticated actor.

### Passwords

- `POST /api/auth/password/request` with `{ "email": "..." }`. The response is intentionally generic to prevent account enumeration.
- `POST /api/auth/password/reset` with `{ "token": "...", "newPassword": "..." }`.
- `POST /api/auth/password/change` with `{ "currentPassword": "...", "newPassword": "..." }`.

Reset tokens are random, SHA-256 hashed in Turso, single-use, and expire in one hour. In local development a token may be returned for testing; production delivery is handled by the organization's own SMTP/notification process.

## Roles and users

Roles are enforced server-side:

| Capability | admin | editor | viewer |
| --- | --- | --- | --- |
| Browse, preview, download | yes | yes | yes |
| Upload and edit metadata | yes | yes | no |
| Trash and restore | yes | yes | no |
| Permanent delete | yes | no | no |
| Users, settings, API keys, audit | yes | no | no |

Admin endpoints:

- `GET /api/users?limit=100`
- `POST /api/users` with `{ email, password?, displayName?, role }`
- `GET /api/users/:uid` — user audit activity
- `PATCH /api/users/:uid` with `{ role? , disabled? }`
- `POST /api/users/:uid/reset-password` with optional `{ password }`
- `DELETE /api/users/:uid/sessions` — revoke all sessions
- `DELETE /api/users/:uid` — soft-delete and disable the account

When an administrator omits a password, the server generates a temporary password and returns it once in the create/reset response. It must be transmitted to the user through a secure channel and changed immediately.

### Creating a user

`POST /api/users` validates the payload with Zod before any database work:

| Field | Rule |
| --- | --- |
| `email` | Required, valid address, max 256 characters. Trimmed and lower-cased, so addresses cannot be duplicated by casing. |
| `password` | Optional. When present it must satisfy the account password policy (minimum 12 characters). An empty string is treated as omitted and a temporary password is generated. |
| `role` | Required, exactly one of `admin`, `editor`, `viewer`. |
| `displayName` | Optional, max 120 characters. |

A created account is immediately usable: it is stored with `id`, `email`,
`password_hash`, `role`, `status`, `created_at`, `updated_at` and
`last_login_at`, and the user can sign in at `/admin/login` with the email and
initial password straight away.

Failures return a specific, safe message — never a generic
"something is invalid" string — with the offending fields in `error.fields`:

| Condition | Status | `error.code` | `error.message` |
| --- | --- | --- | --- |
| Malformed email | 400 | `VALIDATION_ERROR` | `Enter a valid email address.` |
| Password below policy | 400 | `VALIDATION_ERROR` | `Password must be at least 12 characters.` |
| Unknown role | 400 | `VALIDATION_ERROR` | `Role must be admin, editor, or viewer.` |
| Email already registered | 409 | `USER_EXISTS` | `An account with this email already exists.` |
| Caller is not an admin | 403 | `FORBIDDEN` | `You do not have permission to perform this action.` |
| Database unreachable | 503 | `DATABASE_UNAVAILABLE` | `The database is temporarily unavailable. Please retry shortly.` |
| Database not configured | 503 | `DATABASE_NOT_CONFIGURED` | Names the missing environment variables. |
| Unexpected failure | 500 | `USER_CREATE_FAILED` | `User creation failed. Please try again.` |

SQL text, driver output and secret material are never included in a response;
those stay in the structured server logs, correlated by `requestId`.

### Password storage

Passwords are hashed with scrypt (`N=2^16, r=8, p=2`, 16-byte random salt,
64-byte digest) — one of the configurations that meets the OWASP Password
Storage Cheat Sheet minimum. Each hash records its own parameters, so stored
hashes written with older settings keep verifying and are transparently
re-hashed to the current policy on the next successful sign-in. Plaintext
passwords are never stored, logged, or written to the audit trail.

## File library

Cookie-authenticated endpoints:

- `GET /api/files` — list active files with search, category, retention, status, sort, and cursor filters.
- `POST /api/files/upload/init` — validate metadata and create a pending Turso metadata row.
- `POST /api/files/:id/complete` — verify the private Blob object and activate the row.
- `GET /api/files/:id` — metadata.
- `PATCH /api/files/:id` — title, description, category, tags, and retention.
- `POST /api/files/:id/favorite` — set favorite state.
- `GET /api/files/:id/preview` — authenticated inline PDF stream.
- `GET /api/files/:id/download` — authenticated attachment stream.
- `POST /api/files/:id/restore` — restore from Trash.
- `DELETE /api/files/:id` — move to Trash.
- `POST /api/files/:id/permanent-delete` — permanently delete after typed confirmation.
- `GET /api/files/trash` — Trash listing.
- `POST /api/files/bulk` — authorized bulk operations.
- `GET /api/files/export` — metadata export for administrators.
- `POST /api/blob/upload` — issue a presigned PUT for a pending upload (SDK upload callback endpoints).

The server checks the file row and caller role before every object operation. The response never includes `storage_path`, upload keys, or permanent public URLs.

## Blob diagnostics

`GET /api/blob/health` (administrator session, 60 requests/minute) reports the real state of the private Blob store: provider, `status` (`ok`/`degraded`), `configuration` (auth mode, store id, missing variables, no secret values), a non-destructive list probe, and the exact `errorCode`, `errorName`, `error`, and `hint` when the store cannot be reached. `GET /api/blob/health?deep=true` (6 requests/minute) additionally performs a put → head → get → delete round trip against `health/doctor-<uuid>.pdf` and removes the probe object.

Configuration problems are never masked: `503 BLOB_NOT_CONFIGURED` carries the exact missing variables (`BLOB_STORE_ID` or `BLOB_READ_WRITE_TOKEN`), and signing failures return `502 BLOB_SIGNING_FAILED` with the real SDK error name and message. `/api/health`, `/api/system/health`, and `/api/storage` expose the same diagnostics, and `GET /api/v1/health` returns `blobConfigured`, `blobAuthMode`, and `missingBlobConfig`.

## API keys and `/api/v1`

Administrators create keys at `POST /api/api-keys`:

```json
{
  "name": "Website production",
  "description": "Server-side website integration",
  "scopes": ["files:read", "files:download"],
  "expiresAt": null
}
```

The response contains a bearer secret exactly once. Only its SHA-256 digest is stored. The server checks key existence, expiry, revocation, and scopes on every request. `PATCH /api/api-keys?rotate=true` rotates a key, and `DELETE /api/api-keys?id=<record-id>` revokes it.

### External integrations (key id + secret)

An external website authenticates with the two credential headers returned when
the key was created. No browser cookie or session is involved, and Firebase is
not used anywhere in this path:

```http
POST /api/v1/files
X-AM-Storage-Key-Id: ng_key_<key-id>
X-AM-Storage-Key-Secret: ng_live_<secret>
Content-Type: multipart/form-data
```

The equivalent, already-documented bearer form is also accepted:

```http
Authorization: Bearer ng_live_<secret>
```

Example upload with cURL:

```bash
curl -X POST https://<your-app>/api/v1/files \
  -H "X-AM-Storage-Key-Id: ng_key_…" \
  -H "X-AM-Storage-Key-Secret: ng_live_…" \
  -F "file=@report.pdf;type=application/pdf" \
  -F "title=Annual Report"
```

On success the API returns `201` with the persisted metadata:

```json
{
  "success": true,
  "data": {
    "file": {
      "id": "7fa7a823-d6bd-495a-bc6b-149de45a9539",
      "originalName": "report.pdf",
      "size": 563,
      "mimeType": "application/pdf",
      "status": "active"
    },
    "url": "https://…signed…",
    "expiresAt": "2026-09-12T03:29:30.000Z"
  },
  "requestId": "…"
}
```

Every request is verified against key existence, revocation, expiry, the stored
SHA-256 secret digest, and the required scope. Uploads require `files:upload`.
Only PDFs are accepted: the filename extension, the declared MIME type, and the
file's magic bytes (`%PDF-` header and `%%EOF` trailer) are all validated
server-side before anything is written to the private Blob store.

### Verifying a key

`POST /api/v1/auth/test` authenticates with the same headers and returns a
step-by-step report covering key → scope → upload permission → Vercel Private
Blob round trip → database. The admin API Playground calls this endpoint and
sends the identical headers an external site sends, so a green result there
means a green result from cURL.

### CORS

Browser-based integrations must be allow-listed via the `CORS_ORIGINS`
environment variable. The allowed origin is echoed back explicitly alongside
`Access-Control-Allow-Credentials: true`; a wildcard `*` is never returned.

The embedded versioned API includes:

- `GET /api/v1/health`
- `GET /api/v1/files`
- `GET /api/v1/files/:id`
- `GET /api/v1/files/:id/download`
- `PATCH /api/v1/files/:id`
- `DELETE /api/v1/files/:id`
- `POST /api/v1/files/:id/restore`
- `POST /api/v1/files` — multipart PDF upload (scope `files:upload`)
- `POST /api/v1/auth/test` — verify a key end to end
- `POST /api/v1/storage/upload`
- `POST /api/v1/storage/upload/init`
- `POST /api/v1/storage/upload/complete`

A missing scope returns `403 INSUFFICIENT_SCOPE`; an invalid, expired, or revoked key returns `401 INVALID_API_KEY`. The 401 body is deliberately identical for every credential failure so the API cannot be used to probe which key ids exist; the precise reason (`not_found`, `revoked`, `expired`, `bad_secret`) is recorded in the server logs with the `requestId`. Scope resolution is fail-closed: a key with an empty or unreadable scope list is granted nothing. Key registry/database failures return `503 KEY_SERVICE_UNAVAILABLE`, never a misleading bad-key response.

## Rate limiting, audit, and status codes

Login, password reset, user management, uploads, and API-key operations are rate limited. API requests and upload attempts are persisted in Turso with request IDs. Security-sensitive actions write immutable-style audit rows. Common statuses are:

- `200` successful read/update
- `201` created user, key, or file
- `400` invalid input or lifecycle transition
- `401` missing/invalid session or API key
- `403` valid identity without permission or invalid origin
- `404` missing resource
- `409` conflict, duplicate user, or invalid state transition
- `429` rate limit exceeded
- `500` unexpected application failure
- `502` private Blob operation failed
- `503` Turso, Blob, or configuration dependency unavailable

## Retention and cron

`GET /api/cron/cleanup` requires `Authorization: Bearer <CRON_SECRET>` and is scheduled daily by `vercel.json`. It uses Turso locking, per-file failure isolation, private Blob deletion, and audit records. Administrators may call `POST /api/cleanup` for a manual run; the cron secret is never exposed to the browser.
