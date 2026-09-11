# Production setup

## 1. Turso (libSQL)

Create a Turso database (`turso db create`) and a database token (`turso db tokens create <db-name>`). Set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` and run:

```bash
npm ci
npm run db:migrate
```

The migration runner uses a libSQL write transaction (SQLite serializes writers), records applied versions in `schema_migrations`, and is safe to run on every deployment. Set `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD` only for the first migration; the bootstrap password must be at least 12 characters.

For Vercel, use a connection pooler or a provider connection string with a small pool. `src/lib/db/client.ts` caps the application pool and converts unavailable database failures into structured `503` errors.

## 2. Vercel Private Blob

1. Attach a Vercel Blob store to the same Vercel project.
2. Keep the store private; do not configure a public custom domain for documents.
3. Connecting the store to the project is the configuration: Vercel injects `BLOB_STORE_ID` and `BLOB_WEBHOOK_PUBLIC_KEY`, and the runtime issues a short-lived OIDC token per request (`x-vercel-oidc-token`) that the Blob SDK reads automatically. Do **not** create `VERCEL_OIDC_TOKEN` by hand.
4. Optional: set the server-only `BLOB_READ_WRITE_TOKEN` to use a static credential instead (it takes precedence over OIDC). For local development against a real store, run `vercel env pull`.
5. Confirm `GET /api/blob/health` reports a healthy store (`?deep=true` for a put/head/get/delete round trip) and `/api/v1/health` reports the Blob store as ready after authentication. Both return the exact missing variable and the real Blob error when something is wrong; [VERCEL-BLOB.md](VERCEL-BLOB.md) lists every diagnostic code and how to verify a real PDF on production.

Only `src/lib/storage/vercel-blob.ts` talks to Blob. The database stores the private pathname and metadata, never document bytes. Preview and download are authorized server streams.

## 3. Secrets and deployment variables

Required variables are documented in `.env.example`. Generate secrets with a cryptographically secure generator, use separate values per environment, and never prefix server secrets with `NEXT_PUBLIC_`.

- `CRON_SECRET` authenticates Vercel Cron.
- `NEXT_PUBLIC_APP_URL` is the canonical HTTPS origin.
- API key secrets are random, shown once, and stored only as SHA-256 digests; no reversible API-secret encryption variable is used.

## 4. Vercel Cron

`vercel.json` schedules `/api/cron/cleanup` daily. Vercel sends `Authorization: Bearer <CRON_SECRET>`. Check the deployment logs and `/api/system/health` after the first run.

## 5. First smoke test

1. Run the migration and sign in as the bootstrap administrator.
2. Create an editor and viewer under `/admin/users` with unique passwords.
3. Verify editor upload/edit/Trash permissions and viewer read-only behavior.
4. Upload a known-safe PDF, preview it, download it, edit metadata, move it to Trash, restore it, and permanently delete it.
5. Confirm the file row exists in Turso and the object exists only in the private Blob store.
6. Create an API key, call `/api/v1/health` and `/api/v1/files`, then revoke the key and confirm `401`.
7. Run a cleanup dry run and inspect the audit log.
