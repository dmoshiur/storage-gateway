# Backup and recovery

The system has two production data planes:

1. PostgreSQL: users, sessions, roles, file metadata, categories, tags, API-key digests, audit logs, retention rules, notifications, settings, and cleanup state.
2. Vercel Private Blob: PDF and supported document bytes under random server-generated paths.

Use PostgreSQL point-in-time recovery or encrypted scheduled dumps. The database backup must include `files.storage_path`, content hashes, lifecycle status, and retention timestamps so objects can be reconciled.

Use the private Blob store's supported export/replication process for document bytes. Never make the store public while taking a backup and never export credentials into application logs.

## Recovery order

1. Restore PostgreSQL and run any pending migrations.
2. Restore or reconnect the private Blob store.
3. Reconcile active and Trash file rows against the Blob inventory using server-side credentials.
4. Mark missing objects as failed and create audit records; do not silently recreate metadata.
5. Revoke all sessions and rotate API keys if the database snapshot could have been copied.
6. Verify login, role permissions, preview/download, Trash restore, and cleanup before reopening traffic.

Test a restore at least quarterly in an isolated environment. A successful database dump without the corresponding private object inventory is not a complete document backup.
