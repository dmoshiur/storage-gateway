# AM Storage Company — first-party Storage Gateway

AM Storage Company is a private PDF management system. It is a single Next.js application with a real server-side backend:

```text
Admin browser / trusted API client
              │
              ▼
      Next.js Server and API routes
          │              │
          ▼              ▼
     Turso (libSQL)  Vercel Private Blob
   metadata/auth       PDF bytes only
```

There is no external identity provider and no client-side database SDK. Authentication, authorization, metadata, API keys, sessions, audit records, retention state, notifications, and settings are implemented in this repository.

## Production properties

- Email/password authentication backed by Turso (libSQL/SQLite).
- Passwords are hashed with Node.js `scrypt`; plaintext passwords are never stored.
- Random opaque session tokens are hashed before storage and sent only in secure, HTTP-only, SameSite cookies.
- Session expiry, logout, revocation, disabled accounts, password reset, and password change are server-side operations.
- Roles are `admin`, `editor`, and `viewer`, enforced in every protected route.
- `/admin/users` lets administrators create accounts, assign roles, disable/enable accounts, reset passwords, revoke sessions, delete accounts, and inspect activity.
- Turso stores metadata only. Actual document bytes are stored only in a private Vercel Blob store.
- The browser never receives a permanent document URL. Preview and download are authenticated server streams; temporary signed Blob URLs are minted only for controlled upload/download operations.
- Upload completion verifies file type, size, object metadata, and lifecycle state before a record becomes active.
- Files support search, filters, metadata edits, favorites, Trash, restore, permanent deletion, retention, and automatic cleanup.
- `/api/v1/*` supports bearer API keys, scopes, rate limiting, request IDs, structured errors, and audit logging. Raw API secrets are returned once and only SHA-256 digests are stored.
- Vercel Cron runs the retention and cleanup worker. A single-row cleanup lock inside a libSQL write transaction prevents overlapping cleanup runs.
- No demo records or in-memory backend is used by application routes.

## Quick start

Requirements: Node.js 20.9+, a Turso database (or any libSQL/SQLite URL), and a private Vercel Blob store.

```bash
npm install
cp .env.example .env.local
# Configure TURSO_DATABASE_URL / TURSO_AUTH_TOKEN and BLOB_READ_WRITE_TOKEN in .env.local
npm run db:migrate
npm run dev
```

`npm run db:migrate` applies every file in `migrations/` exactly once. If `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD` are set, it creates the initial administrator only when that email does not already exist. The initial password must be at least 12 characters; remove the bootstrap variables after setup.

Open `http://localhost:3000/admin/login` and sign in with the created administrator. Administrators create additional users from `/admin/users`.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `TURSO_DATABASE_URL` | yes | Turso/libSQL connection string (`libsql://…` for Turso Cloud, `file:…` for local) used by the application |
| `TURSO_AUTH_TOKEN` | yes* | Turso database auth token (*not required for local `file:` URLs) |
| `DATABASE_URL` | fallback | Alternative name for `TURSO_DATABASE_URL` |
| `DIRECT_DATABASE_URL` | migrations | Optional direct Turso URL for `npm run db:migrate` |
| `INITIAL_ADMIN_EMAIL` | first setup | Bootstrap administrator email |
| `INITIAL_ADMIN_PASSWORD` | first setup | Bootstrap administrator password, minimum 12 characters |
| `BLOB_READ_WRITE_TOKEN` | yes | Server-only Vercel Private Blob token |
| `BLOB_STORE_ID` | OIDC deployments | Private Blob store identifier |
| `VERCEL_OIDC_TOKEN` | OIDC deployments | Server-only Vercel OIDC credential |
| `CRON_SECRET` | cron | High-entropy secret for `/api/cron/cleanup` |
| `NEXT_PUBLIC_APP_URL` | recommended | Canonical application URL for operational links |

Do not put any server secret in a `NEXT_PUBLIC_` variable. Use different databases, Blob stores, and secrets for development, preview, and production.

## Database

The migration creates these tables:

- `users`, `roles`, `sessions`, `password_reset_tokens`
- `files`, `categories`, `tags`, `file_tags`
- `api_keys`, `api_request_logs`, `api_upload_logs`
- `audit_logs`, `retention_rules`, `notifications`, `system_settings`
- `cleanup_lock`, `rate_limits`, `webhooks`, `webhook_deliveries`

File rows contain only metadata and private Blob pathname references. `storage_path` and temporary upload fields are server-only and are never included in serialized file responses.

## Authentication and access control

`POST /api/auth/session` and `POST /api/auth/login` accept `{ email, password }`. A successful request creates a database session and sets `storage_gateway_session` as an HTTP-only cookie. `POST /api/auth/logout` revokes the current session. Every admin page and protected API route verifies the session against Turso and checks the role on the server.

Password operations:

- `POST /api/auth/password/request`
- `POST /api/auth/password/reset`
- `POST /api/auth/password/change`
- `POST /api/users/:uid/reset-password` for administrators
- `DELETE /api/users/:uid/sessions` to revoke all sessions for a user

Reset tokens are random, hashed in Turso, single-use, and expire after one hour. `/admin/reset-password` accepts the one-time token. Non-production requests return the token for local testing; production deployments should deliver it through an organization-controlled SMTP or notification worker without changing the first-party authentication model.

## Files and private Blob storage

The only object-storage adapter is `src/lib/storage/vercel-blob.ts`. It uses private Blob operations for upload, copy, metadata, streaming reads, deletion, and short-lived signed URLs. A file's original name is metadata, never an object path. Upload paths are random server-generated paths.

The normal browser flow is:

1. `POST /api/files/upload/init` validates metadata and creates an `uploading` Turso row.
2. The browser uploads bytes to a constrained private Blob operation.
3. `POST /api/files/:id/complete` checks Blob metadata and activates the Turso row.
4. Preview/download routes authenticate the caller, load metadata from Turso, and stream bytes through Next.js.
5. Trash, restore, and permanent delete update the lifecycle in Turso and delete Blob bytes only after the state transition is safe.

The bridge supports the same lifecycle for trusted server callers through `/api/v1/storage/upload` and its init/complete endpoints.

## API keys

Administrators create scoped bearer keys from `/admin/api` or `POST /api/api-keys`. The raw value is displayed exactly once. Turso stores only a SHA-256 digest; revocation and expiry are checked on every request. API responses use JSON envelopes with a request ID and stable error code. The API bridge records request and upload activity and writes audit events.

Supported scopes are defined in `src/lib/security/scopes.ts`. Rate limits apply before expensive operations. Cookie-authenticated mutations require same-origin requests; server-to-server API clients use a Turso-backed API key whose raw secret is shown only once.

## Retention and cleanup

Each file has an explicit retention policy. A daily Vercel Cron request to `/api/cron/cleanup` authenticates with `CRON_SECRET`, acquires the Turso cleanup lock, processes each file independently, and records failures in `audit_logs`. With Trash enabled, automatic expiry first moves a file to Trash. The next cleanup permanently removes expired Trash metadata and Blob bytes. Stale uploads are removed as well.

Run a safe manual preview with `POST /api/cleanup?dryRun=true` as an administrator. The production cron route is configured in `vercel.json`.

## Verification commands

```bash
npm run db:migrate
npm run typecheck
npm run lint
npm test
npm run build
```

For a deployment smoke test, create an administrator through the migration, create a viewer and editor in `/admin/users`, sign in as each account, verify role restrictions, upload a known-safe PDF, preview/download it, edit metadata, move it to Trash, restore it, permanently delete it, and run the cleanup route with a controlled test record. Confirm Turso contains the metadata and the private Blob store contains the bytes while no permanent public URL is exposed.

## Project structure

```text
migrations/             libSQL (SQLite) schema and indexes
scripts/migrate.mjs     idempotent migration runner and initial admin bootstrap
src/app/                Next.js pages and route handlers
src/lib/auth/           password hashing, sessions, reset tokens
src/lib/db/             Turso (libSQL) repositories
src/lib/storage/        Vercel Private Blob adapter
src/lib/security/       roles, API keys, rate limits, request auth
src/lib/cleanup/        retention and automatic cleanup
src/types/              server/client data contracts
tests/                  first-party unit tests
```
