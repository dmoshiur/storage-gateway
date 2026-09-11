# AM Storage Company — Storage Gateway & Bridge

The official **AM Storage Company** platform is a private **document Storage
Bridge** for PDF, DOC, DOCX, TXT, PPT, and PPTX: an administrative control plane
(Next.js dashboard, Firestore metadata, Cloudflare R2 object storage) with an
embedded API bridge that the public NGO website
[gramunnayan.com](https://gramunnayan.com) calls with dashboard-generated Custom
API Keys. It is a narrow internal infrastructure service — not a public drive,
file-sharing product, or social app.

- **Application:** Next.js 16 App Router + TypeScript + Tailwind CSS
- **Public API bridge:** embedded in the same deployment (`/api/v1/*`) — a legacy standalone FastAPI bridge remains available under [`fastapi/`](fastapi/README.md) but is not required
- **Hosting:** a single Vercel deployment (dashboard + bridge + cron)
- **Identity:** Firebase Authentication with server-verified session cookies
- **Metadata/state:** Cloud Firestore
- **Document bytes:** private Cloudflare R2 bucket, accessed through short-lived S3 presigned URLs
- **Scheduled maintenance:** Vercel Cron + secured Firestore lock

The intended scale is `≤ 10 GB` of documents. The design keeps operations simple
and low-cost while preserving an explicit storage abstraction for a future
provider migration.

> **No document binary is ever stored in Firestore or the Vercel filesystem, and
> Cloudflare R2 credentials are never exposed to gramunnayan.com or its
> visitors.**

## What is included

- Two sign-in methods: the shared administrator passphrase (`ADMIN_PASS`) alone, or Firebase email/password for any provisioned user — both issued as HTTP-only, server-verified session cookies, plus logout
- Server-enforced admin RBAC (`admin`, `editor`, `viewer` policy is centralized and extendable)
- An administrative dashboard branded **AM Storage Company**, with responsive file library, Trash, storage health, audit log, and settings screens
- An **API Management** screen that generates/revokes dual-token credentials — a visible **API Key ID** (`am_store_live_…`) plus a high-entropy **API Secret Key** (`am_sec_live_…`) shown exactly once, Cloudflare R2 style — with ready-made integration snippets for gramunnayan.com
- A dashboard with real-time metric cards (documents stored, storage used vs. the R2 limit, total API requests from gramunnayan.com), a live log of the last 5 API uploads with Success/Failed badges, and a "System Status: Operational" indicator for the embedded Storage Bridge
- An embedded **Storage Bridge** (`POST /api/v1/storage/upload`, plus a presigned init → PUT → complete flow for documents over ~4 MB) that validates the dual-token credential (or an HMAC signature), stores PDF/DOC/DOCX/TXT/PPT/PPTX documents in R2, registers them as managed documents, logs every attempt to the dashboard, and returns signed document URLs
- Direct browser-to-private-R2 signed uploads with progress indicators
- Server-side finalization checks for extension, claimed/actual size, R2 content type, signed file identifier, and type-specific magic bytes
- Staging-to-final R2 copy on finalization so an expiring upload URL cannot overwrite an active document
- Per-file retention: Never, 30 days, 3 months, 6 months, 1 year, custom date
- Soft deletion / recovery with server-confirmed move-to-Trash and typed `DELETE` confirmation for permanent deletion
- Daily cleanup with a Firestore lock, per-file failure isolation, retryable `deleting` state, and audit records
- Secure server-to-server website integration using `X-Storage-Gateway-Key`
- Secure HTTP headers, bounded JSON request sizes, schema validation, same-origin checks for cookie mutations, and best-effort per-instance rate limiting
- Firestore rules, required indexes, R2 CORS template, tests, and deployment documentation

## Version pins and stability fixes

- `firebase-admin` is pinned to exactly **`13.0.0`** (no caret) with an npm
  `overrides` entry for `jwks-rsa` — the combination that permanently fixes the
  ESM/jwks-rsa startup crash. Do not bump it without retesting cold starts and
  session verification.
- Dashboard session initialization is null-safe: an expired, revoked, or corrupt
  session cookie resolves to a signed-out state (redirect to `/admin/login`)
  instead of surfacing a server error on load.

## Storage Bridge for gramunnayan.com

The bridge is **embedded in this same Vercel deployment** — there is no
separate bridge server to host. gramunnayan.com calls this app's own URL:

```text
gramunnayan.com (server)
      │  POST /api/v1/storage/upload  (multipart PDF/DOC/DOCX/TXT/PPT/PPTX, ≤ ~4 MB)
      │  Headers: X-AM-Storage-Key-Id + X-AM-Storage-Key-Secret
      │           (or HMAC: X-AM-Storage-Signature + X-AM-Storage-Timestamp)
      ▼
┌──────────────  AM Storage Company — single Vercel deployment ────────────────┐
│ Embedded bridge: validates credential · document gate · stores in R2 ·      │
│ registers doc · logs every attempt (success or failure) to the dashboard    │
│ Firestore metadata · audit · retention · dashboard · cron                   │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ R2 credentials (private, server-only)
                                       ▼
                               Cloudflare R2
                               private document bytes
```

1. Generate a credential pair in the dashboard under **API Management** (Admin → API Management).
2. Copy the snippet and set the variables on the gramunnayan.com **server**
   (`AM_STORAGE_BRIDGE_URL`, `AM_STORAGE_KEY_ID`, `AM_STORAGE_KEY_SECRET`) —
   never in browser code. `AM_STORAGE_BRIDGE_URL` is **this app's own URL**
   (for example `https://st.thamjj13.top`).
3. The bridge verifies the credential against the registry (revocation is
   immediate, `lastUsedAt` is tracked, every attempt is logged on the
   dashboard), validates the document, stores it in R2, registers the document,
   and returns `{ file, url }` where `url` is a short-lived signed document URL
   for visitors.
4. Check liveness anytime with `GET <app-url>/api/v1/health` — the response
   includes `"bridge": "ready"` and `"mode": "embedded"`.

### Upload size guidance

Vercel functions reject request payloads above ~4.5 MB before application code
runs, so:

- documents up to **~4 MB** use direct multipart `POST /api/v1/storage/upload`;
- larger documents (up to the configured max, default **50 MB**) use the
  presigned flow: `POST /api/v1/storage/upload/init` → `PUT` the bytes straight
  to the returned R2 URL → `POST /api/v1/storage/upload/complete`. The dashboard
  **API Management** page has a ready-made snippet for both flows.

### Troubleshooting

- A **404 with an HTML body** on `/api/v1/*` means the request did not reach a
  current deployment of this app (stale edge cache, wrong host, or a proxy
  rewriting the path). Current deployments answer every `/api/v1/*` path with
  JSON: unknown subpaths return `404 UNKNOWN_BRIDGE_ROUTE` naming the path.
- `401 INVALID_API_KEY` means the credential headers are missing, revoked, or
  mistyped. `503 KEY_SERVICE_UNAVAILABLE` means the Firestore registry itself
  is unreachable — retry shortly.
- `503 SIGNATURE_VERIFICATION_UNAVAILABLE` on HMAC signed requests means the
  deployment has no `AM_STORAGE_MASTER_KEY`; either set it or use the dual-token
  headers.

A legacy standalone FastAPI bridge remains available under [`fastapi/`](fastapi/README.md)
(optional, self-hosted via the bundled Dockerfile or [`render.yaml`](render.yaml));
the gateway-internal bridge routes (`POST /api/internal/bridge/verify-key`,
`POST /api/internal/bridge/files`, `POST /api/internal/bridge/upload-logs`) are
server-to-server only, require the `X-Storage-Gateway-Key` header, and exist
solely for that external bridge.

## Architecture

```text
NGO website server                         Admin browser
       │                                         │
       │ X-AM-Storage-Key-Id/Secret              │ Firebase email/password
       │ (or X-Storage-Gateway-Key reads)        │ (or ADMIN_PASS)
       ▼                                         ▼
┌───────────────────────────── Vercel / Next.js ─────────────────────────────┐
│ Embedded bridge (/api/v1/*) · API routes · RBAC · retention · audit · cron │
│               │                                      │                     │
│               ▼                                      ▼                     │
│      Firebase Auth (session verification)     Firestore metadata/state      │
│                                                       │                     │
│       signed upload/download URL only                ▼                     │
│                    └────────────────────► Private Cloudflare R2 ◄─────────┘
│                                               document bytes only
└─────────────────────────────────────────────────────────────────────────────┘
```

The NGO main website talks to gateway routes only. It never needs R2 credentials, a bucket layout, Firebase Admin credentials, or permanent object URLs.

## Security model

### Server-only secrets

`R2_*`, `FIREBASE_PRIVATE_KEY`, `FIREBASE_CLIENT_EMAIL`, `ADMIN_PASS`, `INTEGRATION_API_KEY`, and `CRON_SECRET` are only read by modules marked `server-only`. Never use a `NEXT_PUBLIC_` prefix for any of them. Start from [`.env.example`](.env.example); it contains placeholders only.

The Firebase Web SDK configuration is intentionally `NEXT_PUBLIC_*`: it identifies the Firebase project, but does **not** grant database or R2 administrative access. Firestore Rules and server-side authorization still protect data.

#### One Firebase project, end to end

Every Firebase identifier must come from the **same Web App inside the same Firebase project** as the server Admin SDK (`FIREBASE_PROJECT_ID`). In Settings → Firebase Configuration the paste box, the `.env.local` baseline, and the Vercel variables must all agree:

- `NEXT_PUBLIC_FIREBASE_PROJECT_ID` equals `FIREBASE_PROJECT_ID` (e.g. `am-st-b507f`);
- `apiKey`, `authDomain`, `projectId`, `messagingSenderId`, and `appId` are copied together from Firebase Console → Project settings → General → Your apps → **Web app** — never mixed between projects;
- the project number in `appId` (`1:<projectNumber>:web:<hash>`) is identical to `messagingSenderId` — the dashboard validates this before saving and rejects a config whose fields disagree.

**Test connection** proves identity three independent ways, with no mock data:

1. Identity Toolkit `getProjectConfig` is called with the API key. That endpoint returns the key's GCP project **number** in its `projectId` field (not the string id); it must equal the number embedded in `appId`/`messagingSenderId`, and the project's default `<projectId>.firebaseapp.com` / `.web.app` domains must appear in `authorizedDomains`. A mismatch reports `WRONG_PROJECT` with both numbers.
2. A Firestore REST read of the non-existent, **non-reserved** probe document `systemHealth/gatewayProbe` proves the key is accepted for that project. Firestore rejects cross-project keys with `PERMISSION_DENIED` / `CONSUMER_INVALID` ("Permission denied on resource project …"), and reserves ids matching `__.*__` — the probe never uses such ids.
3. The server Admin SDK project id must equal the web config project id, otherwise browser ID tokens could never verify and existing users could never sign in.

The browser test additionally initializes the real Web SDK (Auth **and** Firestore), checks the Email/Password provider with a deliberately unknown user, and verifies the current hostname is in Firebase's Authorized domains (the exact list that gates `auth/unauthorized-domain`). Saving a config runs these identity checks server-side first; definitive mismatches (invalid key, wrong project, Admin mismatch, Firestore disabled) block the save. A network outage never fakes success — the config is saved but returned as unverified with the reason, and Test connection must be re-run.

### Authentication and roles

The login page offers two independent sign-in methods:

1. **Shared passphrase.** The shared administrator passphrase (`ADMIN_PASS`) signs in directly with full administrator access — no Firebase account is required. It is checked server-side by `POST /api/auth/pass` using a constant-time comparison, rate limited per client IP, and returns an HTTP-only, SameSite=Lax session cookie holding an HMAC-signed shared-pass session. Rotating `ADMIN_PASS` invalidates every such session.
2. **Firebase email/password.** Any user created in Firebase Authentication signs in with their email and password. The page sends the short-lived Firebase ID token to `POST /api/auth/session` over same origin, the server verifies it with Firebase Admin and evaluates the custom role claim (or documented `ADMIN_EMAILS` bootstrap allowlist), and issues an HTTP-only, SameSite=Lax Firebase session cookie.

Every dashboard route verifies the cookie server-side and enforces the actor role: `admin` has full control, `editor` and `viewer` get read-only access (browse, view, download; no uploads, edits, deletion, settings, or audit log). The browser’s UI state is never trusted for authorization.

Use Firebase custom claims for production roles, e.g. `{ role: "admin" }`. `ADMIN_EMAILS` is a convenient bootstrap fallback, not a replacement for controlled role provisioning.

### Document upload protection

The browser performs early UX checks, but those are not trusted. The server:

1. validates metadata and the configurable maximum byte size before issuing a signed upload URL;
2. creates an `uploading` Firestore record with a random R2 **staging** key;
3. finalizes only after it reads R2 metadata and byte ranges itself;
4. checks the supported extension, actual size, expected content type, the signed R2 metadata file ID, and type-specific magic bytes (`%PDF-`, OLE2 for DOC/PPT, ZIP for DOCX/PPTX);
5. copies the verified staging object to a random final key such as `documents/2026/09/<uuid>.pdf`; and
6. marks the Firestore record `active` only after that copy succeeds.

The original filename is metadata only — never an object key. This structural gate is not antivirus/malware scanning; add a malware scanning service if organizational policy requires it.

### Lifecycle and deletion safety

```text
uploading ──verify──► active ──manual/automatic──► trash ──restore──► active
   │                                              │
   └──invalid/expired──► failed ──orphan cleanup──┘
                                                  │ permanent confirmation / trash expiry
                                                  ▼
                                              deleting ──success──► deleted
                                                  └──failure──► trash (retryable)
```

With default settings, automatic deletion **moves the metadata to Trash but leaves the private R2 object intact** for 30 days. This is deliberately safer than deleting the bytes before allowing recovery. At Trash expiry, R2 is deleted first and metadata transitions to `deleted`; records remain for audit/recovery evidence. If an administrator explicitly turns safety mode off, due files are permanently deleted.

## Quick start (development)

### 1. Install

```bash
npm install
cp .env.example .env.local
```

Fill `.env.local` with a dedicated **development** Firebase project and R2 bucket. Never point an unreviewed local environment at production storage.

### 2. Configure Firebase, R2, Firestore

Follow the detailed steps in [docs/SETUP.md](docs/SETUP.md). At a minimum:

- enable Firebase Email/Password authentication;
- create an admin custom claim or add your initial address to `ADMIN_EMAILS`;
- create a **private** R2 bucket and a least-privilege S3 API token;
- configure R2 CORS from [`r2-cors.json`](r2-cors.json), replacing placeholder origins;
- deploy [`firestore.rules`](firestore.rules) and [`firestore.indexes.json`](firestore.indexes.json).

### 3. Run

```bash
npm run dev
# http://localhost:3000/admin/login
```

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_FIREBASE_API_KEY` | yes | Firebase Web SDK identifier |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | yes | Firebase Web SDK auth domain |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | yes | Firebase Web SDK project ID |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | yes | Firebase Web SDK application ID |
| `FIREBASE_PROJECT_ID` | yes | Firebase Admin project ID |
| `FIREBASE_CLIENT_EMAIL` | yes | Firebase Admin service account email |
| `FIREBASE_PRIVATE_KEY` | yes | Firebase Admin service account private key; preserve escaped newlines |
| `ADMIN_EMAILS` | bootstrap | comma-separated initial admins; custom claim is preferred |
| `ADMIN_PASS` | yes | shared administrator passphrase; signs in directly with full admin access |
| `R2_ACCOUNT_ID` | yes | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | yes | R2 S3 API access key, server only |
| `R2_SECRET_ACCESS_KEY` | yes | R2 S3 API secret, server only |
| `R2_BUCKET_NAME` | yes | private R2 bucket name |
| `R2_ENDPOINT` | yes | account-specific S3 endpoint |
| `INTEGRATION_API_KEY` | yes | long random server-to-server website key |
| `CRON_SECRET` | yes | long random secret for Vercel Cron Authorization header |
| `AM_STORAGE_MASTER_KEY` | recommended | base64 32-byte key that AES-256-GCM encrypts each generated API Secret Key at rest (the SHA-256 hash is always stored; encryption enables bridge HMAC-signature verification). Generate with `openssl rand -base64 32` |
| `NEXT_PUBLIC_APP_URL` | recommended | canonical per-environment app URL |

Use separate Firebase projects, R2 buckets, and different `INTEGRATION_API_KEY` / `CRON_SECRET` values for development, preview, and production.

## Default settings

Settings are held in `settings/app`. When absent, safe defaults are used; the first settings save persists them.

| Setting | Default |
| --- | ---: |
| Maximum document size | 50 MB |
| Configured storage limit | 10 GB |
| Default auto-delete | Off |
| Default retention | 6 months |
| Move automatic deletions to Trash first | On |
| Trash retention | 30 days |
| Signed download URL lifetime | 10 minutes |
| Storage warning / critical | 80% / 90% |

Changing a global default affects **new uploads only**. The settings form has an explicit, audited “Apply to existing active documents” control; it is unchecked by default.

## Data model

Firestore contains metadata only:

```text
users/{uid}           operational profile / last sign-in; no role authority
auditLogs/{logId}     immutable-style administrative event records
files/{fileId}         document metadata, lifecycle status, retention timestamps
settings/app          application settings
system/cleanupLock    scheduled cleanup lock and last summary
```

A file record includes `storageKey`, title, description, category, tags, MIME type, byte size, timestamps, uploader UID, retention fields, status, and deletion information. `storageKey` and temporary `uploadKey` are never serialized through the public API response shape.

Roles come from Firebase custom claims, not the `users` collection. Firestore’s Admin SDK bypasses Rules, which is why every server route performs its own authorization check.

## Admin workflow

- **Dashboard:** capacity, active count, expiring soon, Trash, recent uploads/deletions, readable warning state.
- **Files:** drag/drop upload, direct upload progress, search across filename/title/description/category/tags, retention filters and cursor pagination.
- **Trash:** recover objects while still present in R2; permanent delete needs server-side `DELETE` confirmation.
- **Storage:** metadata-based totals and manually triggered secure cleanup.
- **Audit logs:** login, logout, upload, download, metadata / retention changes, recovery, deletion, settings changes, and cleanup failures.
- **Settings:** server-enforced limits, lifecycle safety defaults, URL expiry, and warning thresholds.

The UI is responsive: file rows become cards below the table breakpoint. Dialogs are custom accessible dialogs with Escape/backdrop close behavior and focus restoration; browser `confirm()` is never used.

## API and NGO website integration

See [API.md](API.md) for endpoint contracts, errors, curl examples, and a server-to-server website example.

Do **not** place `INTEGRATION_API_KEY` in browser JavaScript. The NGO website’s server should call the gateway with:

```http
X-Storage-Gateway-Key: <INTEGRATION_API_KEY>
```

Integration callers get only active, non-expired document metadata and short-lived download URLs. They cannot upload, modify settings, delete, restore, see Trash, or read audit logs.

## Scheduled cleanup

[`vercel.json`](vercel.json) schedules `GET /api/cron/cleanup` daily at 03:17 UTC. The route requires:

```http
Authorization: Bearer <CRON_SECRET>
```

Vercel automatically sends this header when a `CRON_SECRET` environment variable is configured. The route also supports `POST` for an authenticated scheduler. The dashboard uses the separate authenticated `POST /api/cleanup` route and never receives the cron secret.

The job uses a Firestore transaction lock, processes records independently, and records per-file failures without stopping the batch. A stuck `deleting` lifecycle state is intentionally retried because S3/R2 deletion is idempotent. Details are in [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Tests and verification

```bash
npm run typecheck
npm run lint
npm test
npm run test:coverage  # optional coverage report
npm run build
```

The included tests cover session creation/unauthorized login/logout cookie behavior (with service mocks), document structural validation and oversize rejection, retention durations/custom dates/Never, admin authorization policy, lifecycle transitions, cleanup eligibility, and retry-oriented state selection. See [docs/TESTING.md](docs/TESTING.md) for Firebase Emulator and R2 staging smoke tests required before production rollout.

## Deployment checklist

1. Follow [docs/SETUP.md](docs/SETUP.md) and deploy Firestore Rules/indexes.
2. Add all environment variables in Vercel **for each environment**; never commit `.env.local`.
3. Configure R2 CORS to include production and each preview origin that needs direct uploads.
4. Confirm the R2 bucket has no public access / custom public domain.
5. Add `CRON_SECRET` in Vercel and confirm the Vercel Cron entry appears after deploy.
6. Sign in as an admin; upload a known-safe test document; verify view/download, move-to-Trash, restore, and permanent deletion in a non-production bucket.
7. Send an integration request only from the NGO website server.
8. Review Audit Logs and Vercel function logs; never log credentials, ID tokens, or signed URLs.

## Backups and operational notes

R2 durability is not the same as a complete backup strategy. The gateway deliberately does not implement an expensive backup service. Before storing irreplaceable records, establish an NGO policy for periodic metadata export and a separately permissioned second R2 bucket or external archival copy. See [docs/BACKUP.md](docs/BACKUP.md).

For a larger organization or globally coordinated rate limiting, add a managed rate limiter/WAF; the included limiter is deliberately lightweight and applies per warm Vercel instance. Vercel WAF/rate rules should be configured as a production defense-in-depth layer.

## Project structure

```text
src/
  app/                  App Router pages and API routes
  components/           accessible dashboard, file, modal, and UI components
  lib/
    auth/               session creation and centralized role policy
    firebase/           isolated client/Admin SDK initialization
    firestore/          metadata, settings, audit, stats, and cleanup lock repositories
    storage/            provider-neutral StorageService + R2 implementation
    validation/         Zod inputs and document structural checks
    retention/          server-side date calculation
    cleanup/            cleanup orchestration and eligibility policy
    security/           API key, cron, origin, and rate-limit checks
  types/                shared data contracts
  utils/                date and presentation helpers
tests/                  critical unit tests
docs/                   setup, testing, operations, backup guidance
```

## License / ownership

Add your NGO’s preferred license and data governance policy before public source distribution. This repository itself should remain private if its operational structure is sensitive.
