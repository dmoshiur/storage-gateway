# Testing and production verification

## Automated checks

Run before every deployment:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Included Vitest coverage exercises:

- mocked session-route creation, unauthorized login rejection, and logout cookie clearing, plus admin role resolution;
- PDF extension/signature/EOF, R2 size/ownership checks, and oversize rejection;
- 30-day, 3-month, 6-month, 1-year, custom-date, and Never retention handling;
- active → Trash → restore and transient permanent-deletion lifecycle rules;
- expired/non-expired cleanup eligibility and stale upload selection.

## Firebase Emulator integration tests (recommended)

Use a non-production Firebase project or Emulator Suite for route integration tests. Do not attempt to emulate R2 with production credentials.

1. Configure Firebase Auth Emulator and Firestore Emulator.
2. Create an admin test user and assign an `admin` custom claim through Admin SDK.
3. Assert login yields an HTTP-only session cookie.
4. Call an admin mutation without the cookie and assert `401`/`403`.
5. Call `POST /api/auth/logout`, then assert the cookie is cleared and `GET /api/auth/me` rejects.
6. Stub the `StorageService` in a route/service test to simulate R2 HEAD/range/copy/delete outcomes.

The storage abstraction in `src/lib/storage/storage-service.ts` is designed expressly to make such tests independent of a live bucket.

## Non-production R2 smoke test

Before production, use a dedicated test bucket and a harmless valid PDF:

1. Sign in as an authorized admin.
2. Upload a valid PDF below the configured limit; verify progress, `UPLOAD` audit event, and active file listing.
3. Attempt a `.txt` file renamed `.pdf`, invalid header, missing EOF marker, and an oversize PDF. Confirm no active record is created.
4. View and download an active PDF. Confirm the returned R2 URL expires and the bucket is not anonymously browseable/public.
5. Update title/category/tags and each retention option. Confirm `deleteAt` is set by the server and `CHANGE_RETENTION` is logged.
6. Move a PDF to Trash. Confirm the R2 object remains, Restore works, and the original object need not be re-uploaded.
7. Move it back to Trash and enter an incorrect permanent-delete confirmation. Confirm it is rejected. Enter `DELETE`; confirm R2 object is gone and metadata is `deleted`.
8. Create an expired active test record only through a controlled test helper, then invoke cron dry-run and real cleanup. Confirm safety mode moves it to Trash and a failure on one stubbed object does not stop other records.
9. Repeat with `trashEnabled: false` only in test, then restore the safe default afterward.
10. Use the NGO website server (not browser) with `X-Storage-Gateway-Key`; verify read/download work, while Trash/settings/upload endpoints reject it.

## Accessibility and mobile verification

- Use keyboard only: tab through upload, filters, row actions, and dialogs; Escape should close dialogs and focus should return to the trigger.
- Test at roughly 320px, tablet, and desktop widths. File tables should become usable cards on mobile.
- Use a screen reader to check labels, dialog titles/descriptions, upload progress, and status notices.
- Confirm capacity warnings include readable text/icon semantics, not color alone.

## Security verification

- Inspect browser network and built client chunks: no `R2_SECRET_ACCESS_KEY`, Firebase Admin private key, integration key, or cron secret may appear.
- Verify all non-GET cookie routes reject a foreign `Origin`.
- Verify Firestore Rules deny unauthenticated reads/writes and direct client writes.
- Verify R2 CORS allows only intended gateway origins and headers.
- Verify an unauthenticated request to `/api/cron/cleanup` returns `401`.
