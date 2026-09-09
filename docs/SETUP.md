# Firebase, Firestore, R2, and Vercel setup

This guide assumes a separate set of cloud resources for **development**, **preview**, and **production**. Do not reuse production R2 credentials or bucket names locally.

## 1. Firebase project and Authentication

1. Create/select a Firebase project for this environment.
2. In **Authentication → Sign-in method**, enable **Email/Password**. Do not enable anonymous authentication.
3. Create the initial administrator email/password user in Firebase Authentication.
4. In **Project settings → Service accounts**, generate a service-account credential for the gateway server. Store only its project ID, client email, and private key in Vercel environment variables; do not commit downloaded JSON files.
5. In **Project settings → General**, register the Web app and copy its public config values to the `NEXT_PUBLIC_FIREBASE_*` variables.
6. Add local and deployed gateway domains in Firebase Authentication’s authorized domains list.

### Assign production roles

Use Firebase custom claims as the long-term source of truth. From a tightly controlled, server-only administration script or Cloud Function:

```ts
await admin.auth().setCustomUserClaims("FIREBASE_UID", { role: "admin" });
```

The gateway recognizes `admin`, `editor`, and `viewer`, but this release permits dashboard sign-in / mutations only for `admin`. `editor` and `viewer` are intentionally ready for future least-privilege expansion. Set `ADMIN_EMAILS` only to bootstrap a first admin; remove it once custom claims are managed.

## 2. Firestore

1. Create Firestore in Native mode in the same regional strategy appropriate for your NGO.
2. Review [`../firestore.rules`](../firestore.rules). There is no `allow read, write: if true` rule. Browser writes are denied; the gateway uses server-side Admin SDK after server authorization.
3. Install the Firebase CLI in a controlled administrative environment:

   ```bash
   npm install -g firebase-tools
   firebase login
   firebase use <environment-project-id>
   firebase deploy --only firestore:rules,firestore:indexes
   ```

4. Verify the index build status in Firebase Console. Query links may be suggested if an index differs by Firestore SDK version.

`firebase.json` points at the committed rules/index configuration. Required indexes include active retention cleanup, Trash expiry, sorting, and stale upload scans.

### Firestore collections

```text
users/{uid}              last successful login and last known role only
auditLogs/{auto-id}      activity log
files/{auto-id}          PDF metadata and lifecycle; never PDF bytes
settings/app             singleton configuration
system/cleanupLock       scheduler lock / previous summary
```

The `files` document carries a private random final `storageKey` and temporary `uploadKey`, but neither is exposed through the JSON API. Firebase Admin bypasses Rules, so do not add a route that uses it without the existing `requireAdminRequest` / `requireReadActor` checks.

## 3. Cloudflare R2

1. In the Cloudflare dashboard, create a distinct bucket per environment, e.g. `ngo-pdfs-dev`, `ngo-pdfs-preview`, `ngo-pdfs-production`.
2. **Do not enable public bucket access or attach a public custom domain.** The gateway uses R2’s S3 API endpoint only.
3. Create an R2 API token scoped as narrowly as possible to the one bucket: object read/write/delete/list as required by this gateway. Do not use a broad account API token when a bucket-limited token is available.
4. Set:

   ```text
   R2_ACCOUNT_ID
   R2_ACCESS_KEY_ID
   R2_SECRET_ACCESS_KEY
   R2_BUCKET_NAME
   R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
   ```

5. Configure bucket CORS. Start with [`../r2-cors.json`](../r2-cors.json), replacing `https://your-gateway.vercel.app` with all gateway origins that need direct browser upload. Add specific preview hosts only when needed; avoid `*`.

   Required methods/headers:

   ```json
   {
     "AllowedMethods": ["PUT", "GET", "HEAD"],
     "AllowedHeaders": ["content-type", "x-amz-meta-file-id"],
     "ExposeHeaders": ["etag"]
   }
   ```

   The direct browser `PUT` uses only a short-lived presigned staging URL. The final key is produced server-side by an R2 copy operation after PDF verification.

6. Test `HEAD`, range `GET`, `PUT`, `CopyObject`, and `DeleteObject` permissions against the **non-production** bucket before deploying. This gateway needs range reads to validate the header/trailer and `CopyObject` to publish staging bytes safely.

## 4. Local environment

```bash
cp .env.example .env.local
npm install
npm run dev
```

Use quoted escaped newlines in `FIREBASE_PRIVATE_KEY`:

```dotenv
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

Generate long independent secrets, for example:

```bash
openssl rand -base64 48
```

Use one output for `INTEGRATION_API_KEY` and a different output for `CRON_SECRET`.

## 5. Vercel deployment

1. Import the repository into Vercel.
2. Add every variable in `.env.example` through **Settings → Environment Variables**. Scope values correctly to Development, Preview, and Production. Use different Firebase projects/buckets/secrets per environment when possible.
3. Set `NEXT_PUBLIC_APP_URL` to the deployed gateway URL in each environment.
4. Deploy. Vercel uses the standard `npm run build` script.
5. After deployment, open `/admin/login`, sign in using an admin custom claim / bootstrap email, and complete the smoke tests in [TESTING.md](TESTING.md).
6. Set `CRON_SECRET` in the Vercel project. Vercel Cron discovers [`../vercel.json`](../vercel.json) and sends the matching Bearer authorization header to the daily cleanup route.

### Preview deployment note

R2 CORS does not accept a wildcard safely for credential-like signed uploads. Add each preview hostname that staff need to test, or use a dedicated stable preview domain. Keep preview bucket/data isolated from production.

## 6. Hardening review

Before handling real NGO records:

- [ ] Production R2 bucket is private and has no public custom domain.
- [ ] No real `.env*` file is tracked by Git (`git status --ignored` can help verify locally).
- [ ] Firebase Admin variables are absent from `NEXT_PUBLIC_*` names and browser bundles.
- [ ] Firestore Rules/indexes deployed to the intended project.
- [ ] Firebase authorized domains include only legitimate gateway origins.
- [ ] `ADMIN_EMAILS` has been replaced or tightly controlled with custom claims.
- [ ] R2 CORS lists exact gateway origins, not `*`.
- [ ] Website integration secret exists only in the NGO main website server environment.
- [ ] `CRON_SECRET` exists in Vercel and is different from every other key.
- [ ] Vercel WAF/rate rules are configured as a defense-in-depth layer for `/api/*`.
