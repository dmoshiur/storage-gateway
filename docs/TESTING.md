# Testing and release verification

Run the local checks before deployment:

```bash
npm install
npm run db:migrate
npm run typecheck
npm run lint
npm test
npm run build
```

Use a dedicated PostgreSQL database and private Blob store for integration tests. Do not use production credentials in local tests.

## Fifteen-item release gate

1. **Dependency audit:** `package.json`, the lockfile, source imports, environment examples, and deployment config contain no retired third-party auth/database dependency or reference.
2. **Stale-file audit:** there are no retired-provider, provider-config, demo-backend, or mock-service directories left in the application tree.
3. **Migration bootstrap:** `npm run db:migrate` creates PostgreSQL tables, seed roles/settings, and the initial administrator; the second run is a no-op.
4. **First-party login:** the bootstrap administrator and a newly created account can sign in with email/password and receive an HTTP-only, expiring session cookie.
5. **Session security:** logout, expiry, disabled-account rejection, password change, reset-token expiry, one-time reset use, and administrator session revocation work.
6. **Role boundaries:** admin, editor, and viewer permissions are rejected server-side with the correct statuses, regardless of UI controls.
7. **User management:** create, role change, disable/enable, reset password, sign out sessions, delete, last login, and audit activity work from `/admin/users`.
8. **API key secrecy:** key creation returns the secret once, only a one-way digest is present in PostgreSQL, logs contain no secret, scopes are enforced, rotation works, and revocation returns `401`.
9. **API protocol:** `/api/v1` returns request IDs, structured JSON errors, correct status codes, database-backed rate-limit responses, and audit/request metric rows.
10. **Blob upload:** a known-good PDF uploads to Vercel Private Blob, size/MIME/magic-byte checks run before activation, and oversized or invalid bytes are rejected.
11. **Metadata source of truth:** the active file row, categories, tags, retention values, actor, and audit record are in PostgreSQL; Blob contains bytes only.
12. **Private access:** preview/download are authenticated server streams or short-lived signed links; no permanent public PDF URL appears in a browser response, log, or client bundle.
13. **File lifecycle:** edit, favorite, Trash, restore, permanent delete, failed-delete retry, and stale-upload cleanup update PostgreSQL and Blob consistently.
14. **Retention worker:** Vercel Cron authentication, PostgreSQL cleanup locking, automatic retention, Trash expiry, cleanup dry-run, notifications, and retry behavior work.
15. **Production verification:** `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` all pass; inspect client chunks and environment configuration to confirm server secrets remain server-only.

The application intentionally keeps password-reset delivery local-token based. In non-production, `POST /api/auth/password/request` returns a reset token for local testing; production deployments should connect an organization-controlled SMTP/notification worker without changing first-party authentication or password verification.
