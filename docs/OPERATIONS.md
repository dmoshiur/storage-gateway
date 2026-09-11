# Operations

## Database migrations

Run `npm run db:migrate` during deployment before serving traffic. Migrations are transactional and tracked in `schema_migrations`. Take a Turso backup before applying a destructive schema change.

## Cleanup

The daily Vercel Cron worker authenticates with `CRON_SECRET`, acquires the single-row Turso cleanup lock, and processes active expiry, Trash expiry, stale uploads, and interrupted deletions independently. Blob deletion is idempotent. A failed item remains retryable and produces an audit entry.

Administrators can use Storage → Run cleanup now or call `POST /api/cleanup`. Use `?dryRun=true` to inspect eligible records without modifying metadata or Blob objects.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `DATABASE_NOT_CONFIGURED` | Set `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`, redeploy, and run migrations. |
| `DATABASE_UNAVAILABLE` | Check the Turso auth token, database reachability, and Turso Cloud status. |
| `BLOB_NOT_CONFIGURED` | Attach a private Blob store or set the server-only Blob variables. |
| `BLOB_ACCESS_ERROR` | Confirm the token belongs to the store attached to this deployment and the store is private. |
| `SESSION_EXPIRED` | The session expired, was revoked, or the account was disabled; sign in again. |
| `ACCOUNT_DISABLED` | An administrator must enable the user in `/admin/users`. |
| `INVALID_API_KEY` | The key is missing, revoked, expired, or copied incorrectly. Create/rotate it; raw secrets cannot be recovered. |
| `INSUFFICIENT_SCOPE` | Add the required scope or use a key created for the operation. |

Every error response includes a request ID. Use it to correlate the structured application log with the Turso audit/request rows without logging credentials or document URLs.

## Account security

Use `/admin/users` to disable a compromised account, reset its password, and revoke all sessions. Resetting a role or password revokes active sessions. Do not edit password hashes directly. Rotate Blob credentials and API keys if a secret may have been exposed.

## Backups

Back up Turso with point-in-time recovery (Turso Cloud supports it) and retain private Blob data according to organizational policy. A Turso backup alone does not contain PDF bytes, and a Blob inventory alone does not contain the metadata/audit relationship. See `docs/BACKUP.md`.
