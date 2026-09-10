# Operations and cleanup

## Daily cleanup behavior

Vercel Cron invokes `/api/cron/cleanup` at `03:17 UTC` according to `vercel.json`. It must include `Authorization: Bearer $CRON_SECRET`. The endpoint accepts `GET` because Vercel Cron dispatches GET requests; `POST` is also supported for a secure external scheduler.

The cleanup logic performs the following in one lock-protected run:

1. acquires `system/cleanupLock` transactionally; another active lock returns a safe no-op `202`;
2. locates active records where `autoDeleteEnabled == true` and `deleteAt <= now`;
3. if Trash safety is enabled (the default), transitions each record to `trash`, calculates `permanentDeleteAt`, and keeps R2 bytes recoverable;
4. if Trash safety is explicitly disabled, transitions through `deleting`, deletes R2, then marks metadata `deleted`;
5. finds expired Trash records, transitions through `deleting`, deletes R2, then marks `deleted`;
6. retries interrupted `deleting` records because R2 `DELETE` is idempotent;
7. removes abandoned upload staging objects and stale active staging copies; and
8. releases the lock with a summary.

Each file action is isolated. An R2 error for one file does not stop subsequent files. Failures receive a structured server log and `CLEANUP_FAILURE` audit event. Summary fields include `checked`, `movedToTrash`, `permanentlyDeleted`, `staleUploadsRemoved`, `failed`, and `skipped`.

## Manual cleanup

A logged-in administrator can use **Storage → Run cleanup now**. That calls `POST /api/cleanup` with a Firebase-verified session; the browser never receives the cron secret. It is limited to five requests per administrator per hour.

For a controlled dry run via scheduler credentials:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://storage.example.org/api/cron/cleanup?dryRun=true"
```

Dry runs use the lock but make no metadata or R2 changes.

## Failure recovery

| Situation | Gateway behavior | Operator response |
| --- | --- | --- |
| Direct R2 upload succeeds, final Firestore activation fails | `uploading` record remains; completion can be retried | Ask the admin to retry completion/upload; stale staging is eventually cleaned |
| R2 copy to final key fails | File stays `uploading`, no active metadata | Retry `POST /complete`; check R2 token has CopyObject permission |
| R2 staging deletion fails after activation | `uploadKey` is retained internally | Daily cleanup removes only the staging copy later |
| R2 delete fails during permanent deletion | Metadata rolls back to Trash where possible; audit/log records error | Retry permanent delete or wait for cleanup |
| R2 succeeds but Firestore completion is interrupted | Metadata stays `deleting` | Cleanup safely repeats idempotent DELETE and completes record |
| A cleanup lock is stranded | Lock becomes stale after 20 minutes | Next run reclaims it; investigate function timeout/logs |
| `SERVICE_CONFIGURATION_ERROR` | Route is unavailable by design | Check server-only Vercel environment variables; do not paste secrets into tickets |

## Monitoring

Review at least monthly:

- Dashboard storage warning/critical indicators;
- Audit entries for `CLEANUP_FAILURE`, `UPLOAD_FAILED`, and unexpected permanent deletes;
- Vercel function errors/timeouts and cron invocation history;
- R2 bucket access logs / token scope where available;
- Firebase Authentication user and custom-claim changes;
- Firestore index health and usage.

The included in-memory rate limiter intentionally acts per warm Vercel instance to keep this deployment simple. Configure Vercel WAF/rate limiting for globally coordinated protection if the gateway is Internet-reachable.

## Incident actions

1. **Suspected credential exposure:** immediately revoke/rotate the R2 API token, Firebase service account key if exposed, integration key, and cron secret. Update Vercel environment variables, redeploy, and review logs/audit events.
2. **Unexpected automatic deletion:** immediately disable Default automatic deletion / verify Trash safety in Settings. Restore from Trash where possible. Review the relevant `AUTO_DELETE` log and retention metadata.
3. **Storage nearing critical limit:** remove unneeded recoverable Trash documents only after review; avoid changing global limits solely to hide a capacity problem.
4. **Website integration abuse:** rotate `INTEGRATION_API_KEY`, update only the website server, and use Vercel WAF/rate rules. Do not place the replacement key in a frontend build.
