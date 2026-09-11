# Firebase Configuration Manager — complete flow

One secure paste box in **Settings → Firebase Configuration** is the single
source of truth for the Firebase Web SDK config. This document traces the
full path from paste to production login.

## Flow

```text
Admin pastes Web App config in Settings (strict JSON or the standard Firebase JS-object format)
  │  parseFirebaseWebConfig() — required-field detection, format checks,
  │  service-account rejection, unknown-key warnings (all client-side, instant)
  ▼
[Test connection] (optional, pre-save)
  │  Browser probe: REAL Firebase SDK initializeApp on a temp app +
  │  direct Auth/Firestore reachability from this browser
  │  Server probe: POST /api/firebase-config/test — Identity Toolkit,
  │  Email/Password provider, Firestore, Admin project match
  ▼
[Save & apply] → PUT /api/firebase-config (admin + same-origin + rate limit)
  │  Zod validation → Firestore `settings/firebase` {config, updatedAt, updatedBy}
  │  Dev only: `.env.local` NEXT_PUBLIC_FIREBASE_* upsert (best-effort)
  │  Audit: SETTINGS_CHANGE {area:"firebase-config", projectId, …} — no secrets
  ▼
Running app reinitializes immediately (no reload, no redeploy)
  │  applyFirebaseWebConfig() — default Firebase app is deleted and
  │  recreated only when the identity changed; probe apps untouched;
  │  Auth persistence re-armed; current session cookie unaffected
  ▼
Post-save verification (automatic)
  │  Server + browser probes re-run → Connected / Failed with exact reason
  │  [Verify login] — real signInWithEmailAndPassword on an isolated temp
  │  app, then POST /api/firebase-config/verify-login checks the ID token
  │  with the Admin SDK (no session minted, current session untouched)
  ▼
Production baseline sync
   • GET /api/firebase-config (public, cached) is what login + runtime boot from
   • When the stored override differs from the build-time NEXT_PUBLIC_* env,
     Settings shows "Redeploy required" + a Vercel-ready snippet
   • Operator: Vercel → Project Settings → Environment Variables → paste →
     Redeploy. Next build boots from the same project even before Firestore.
```

## Endpoint contract

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /api/firebase-config` | public (rate-limited) | Effective config: stored override → env baseline → missing list. `updatedBy` only for admins. Never 503s. |
| `PUT /api/firebase-config` | admin, same-origin | Validate + persist + dev `.env.local` sync + audit. Returns status + sync result. |
| `DELETE /api/firebase-config` | admin, same-origin | Remove override, fall back to build env + audit. |
| `POST /api/firebase-config/test` | admin, same-origin | Authoritative probe of a candidate or the effective config. |
| `POST /api/firebase-config/verify-login` | admin, same-origin | Verify a fresh ID token with Admin SDK (role resolution included). Mints nothing. |

## Why "Connected" means login works

The browser signs in against the **Web config project**; the server verifies
the resulting ID token with the **Admin SDK project** (`FIREBASE_PROJECT_ID`).
The `admin-match` probe step fails unless those are the same project, so a
green Connected status guarantees an existing Firebase user can complete
`signInWithEmailAndPassword → POST /api/auth/session → dashboard`.

If the projects differ, the fix is explicit: put the same project's
`FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` in
Vercel and redeploy. Admin credentials are never shown in, or accepted by,
this UI — pasting a service-account key is rejected with guidance.

## Failure handling

Unparseable config text, missing fields, malformed appId/projectId, wrong project
(API key belongs to project X ≠ pasted Y), invalid API key, disabled
Email/Password provider, disabled Firestore, Firestore outage, Admin
mismatch, network timeouts — each maps to a distinct step with the exact
upstream reason; nothing is mocked. See `src/lib/firebase/probe-shared.ts`.

## Security notes

- Web App config values are public identifiers (already embedded in the
  client bundle via `NEXT_PUBLIC_*`); they grant no database/admin access.
  Firestore Rules + server authorization still protect all data.
- The UI masks `apiKey`/`appId` in displays; full values appear only in the
  admin's own paste box and the admin-only env snippet.
- No route logs credentials: probes send the public API key exactly as the
  Firebase SDK does, and logs carry only project ids, drift booleans, and
  truncated upstream status messages.
- `[Reset]` is confirm-gated and audited; it cannot lock the operator out
  because the current session cookie is independent of the Web config.
