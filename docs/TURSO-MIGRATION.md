# PostgreSQL → Turso (libSQL) Migration Guide

This project was migrated from PostgreSQL (raw SQL over `pg`) to Turso
(libSQL/SQLite). **The project never used Prisma** — its data layer is raw SQL
behind `src/lib/db/client.ts` — so the migration swapped the driver and
translated the SQL instead of introducing an ORM. This guide documents
everything that changed and how to deploy it.

---

## 1. "Where is the Prisma schema?" — there isn't one

There is no `prisma/schema.prisma` in this repository. The equivalent pieces are:

| Prisma concept        | This project's equivalent                                       |
| --------------------- | --------------------------------------------------------------- |
| `schema.prisma`       | `migrations/001_initial.sql` (SQLite DDL, single source of truth) |
| Prisma Client         | `src/lib/db/client.ts` (`query()` / `withTransaction()`)          |
| `@prisma/adapter-libsql` + `@libsql/client` | `@libsql/client` only                       |
| `prisma migrate`      | `npm run db:migrate` (`scripts/migrate.mjs`)                     |
| `datasource provider` | implicit — `@libsql/client` accepts `libsql://`, `https://`, and `file:` URLs |

### If you ever introduce Prisma (for reference)

The setup you originally asked about would look like this — note that driver
adapters are now the recommended way to use Prisma with Turso:

```bash
npm install @prisma/client @libsql/client
npm install -D prisma
```

```prisma
// prisma/schema.prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["driverAdapters"]
}

datasource db {
  provider = "sqlite"
  url      = "file:./dev.db" // placeholder; the adapter supplies the real URL
}
```

```ts
// src/lib/prisma.ts (hypothetical)
import { PrismaClient } from "@prisma/client";
import { PrismaLibSQL } from "@prisma/adapter-libsql";
import { createClient } from "@libsql/client";

const libsql = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const adapter = new PrismaLibSQL(libsql);
export const prisma = new PrismaClient({ adapter });
```

Migrations against Turso with Prisma are done with
`prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma
--script | turso db shell <db-name>` (or `prisma db push` against a local
`file:` database, since Prisma's migrate command cannot talk to `libsql://`
remotely). This repository does **not** do any of the above — it keeps the raw
SQL architecture.

---

## 2. What changed in the code

### Dependencies

```bash
npm uninstall pg @types/pg
npm install @libsql/client
```

### `src/lib/db/client.ts` — the pg-compatible Turso client

The previous `pg.Pool` was replaced with `createClient()` from
`@libsql/client`, keeping the exact same exported surface
(`query()`, `withTransaction()`, `toDate()`, `nullableIso()`), so none of the
data-access modules changed their call signatures. The client now provides a
thin PostgreSQL-compatibility layer:

- **Placeholders** — PostgreSQL `$1, $2, …` are rewritten to SQLite's native
  numbered `?1, ?2, …` binds. Numbered (not positional `?`) is essential:
  it preserves reusable arguments such as `VALUES ($1, $2, 1, $2)`.
- **Bind coercion** — `Date` → ISO-8601 text (libsql would otherwise store
  epoch milliseconds as text!), `boolean` → `1/0`, arrays → JSON text,
  `undefined` → `NULL`.
- **Result decoding** — restores the shapes PostgreSQL returned: `*_at`
  columns → `Date`, JSON columns (`details`, `value`, `last_summary`) →
  objects, JSON array columns (`tags`, `scopes`, `events`) → arrays, and
  `0/1` → `boolean` for known boolean columns.
- **`rowCount`** — computed as `rows.length || rowsAffected` to match
  `pg.rowCount` semantics for both `SELECT` and `UPDATE/DELETE`.
- **Transactions** — `withTransaction()` uses `client.transaction("write")`.
  SQLite/libSQL serializes writers, which is what PostgreSQL previously got
  from `FOR UPDATE` row locks and advisory locks (both removed from queries).
- **Error mapping** — SQLite unique-constraint errors surface as the same
  `409 RESOURCE_CONFLICT` API error that PostgreSQL's `23505` produced.

### Timestamps

All timestamps are stored as ISO-8601 UTC text in exactly one format —
`2026-01-31T12:00:00.000Z` — produced by either:

- `new Date().toISOString()` in application code (bound as a parameter), or
- `strftime('%Y-%m-%dT%H:%M:%fZ','now')` in SQL (exported as `SQL_NOW` and
  used in column `DEFAULT`s).

Both produce byte-identical strings, so string comparison (`expires_at > ?`,
`ORDER BY created_at`) is chronologically correct.

### SQL dialect translation (per module)

| PostgreSQL construct                     | libSQL/SQLite replacement                                   |
| ---------------------------------------- | ----------------------------------------------------------- |
| `gen_random_uuid()` defaults             | `DEFAULT (lower(hex(randomblob(4))) \|\| '-' \|\| …)` — canonical UUIDv4-format text |
| `now()`, `now() + interval '…'`          | `SQL_NOW` expression or JS-computed ISO parameter            |
| `timestamptz` / `boolean` / `jsonb` / `text[]` / `inet` | `text` (ISO) / `integer 0-1` / `text` (JSON) / `text` (JSON array) / `text` |
| `name = ANY($2::text[])`                 | `name IN (SELECT value FROM json_each($2))`                  |
| `$1 = ANY(events)`                       | `EXISTS (SELECT 1 FROM json_each(events) WHERE value = $1)`  |
| `CROSS JOIN LATERAL unnest(tags)`        | `json_each(files.tags)`                                      |
| `details->>'userId'`                     | `json_extract(details, '$.userId')`                          |
| `count(*)::text` / `::int` casts         | plain `count(*)` (libSQL returns numbers)                    |
| `$1::jsonb` / `$1::boolean` casts        | plain binds                                                  |
| `FOR UPDATE` / `pg_advisory_xact_lock`   | removed — write transactions serialize access                |
| `storage_path ~ '^pdfs/…$'` CHECK        | `storage_path GLOB 'pdfs/[0-9][0-9][0-9][0-9]/[0-9][0-9]/*.pdf'` |
| `ORDER BY … OFFSET n` (bare)             | `ORDER BY … LIMIT -1 OFFSET n` (SQLite requires `LIMIT`)     |
| `bigserial`                              | `integer PRIMARY KEY AUTOINCREMENT`                          |
| Partial + expression indexes             | unchanged — fully supported                                  |
| `ON CONFLICT … DO UPDATE` / `RETURNING`  | unchanged — fully supported (incl. expression targets like `ON CONFLICT (lower(name))`) |

> ⚠️ **Gotcha recorded during migration:** `@libsql/client`'s `execute()`
> silently runs only the **first** statement of a multi-statement string. The
> migration runner splits `.sql` files into statements and uses `batch()`.

### Migration files

The four PostgreSQL migrations were consolidated into a single SQLite-dialect
`migrations/001_initial.sql` (fresh-database migration; legacy column drops
and `NOT VALID` constraint backfills are irrelevant on a new database). The
schema keeps the same table/index layout, including partial indexes
(`WHERE deleted_at IS NULL`) and the case-insensitive uniqueness rules.

---

## 3. Running migrations against the Turso database

```bash
# one-time CLI setup
npm install -g @turso/cli
turso auth login

# database + token (only if you don't already have them)
turso db create am-cloud-api-am-moshiur --location aws-us-east-1
turso db tokens create am-cloud-api-am-moshiur

# push the schema
export TURSO_DATABASE_URL="libsql://am-cloud-api-am-moshiur.aws-us-east-1.turso.io"
export TURSO_AUTH_TOKEN="<token from turso db tokens create>"
export INITIAL_ADMIN_EMAIL="you@example.org"
export INITIAL_ADMIN_PASSWORD="<long unique password>"   # bootstrap admin, once

npm run db:migrate
```

The runner is idempotent: applied versions are tracked in `schema_migrations`,
so it is safe to run repeatedly and on every deployment. Local development can
use a file database instead: `TURSO_DATABASE_URL=file:./local.db`.

---

## 4. Environment variables in Vercel

Set these in **Vercel Dashboard → Project → Settings → Environment Variables**
(all environments: Production, Preview, Development):

| Variable | Value | Notes |
| --- | --- | --- |
| `TURSO_DATABASE_URL` | `libsql://am-cloud-api-am-moshiur.aws-us-east-1.turso.io` | The Turso database URL. |
| `TURSO_AUTH_TOKEN` | token from `turso db tokens create am-cloud-api-am-moshiur` | Server-only secret. Scope it to the database; rotate periodically. |
| `BLOB_STORE_ID` / `BLOB_WEBHOOK_PUBLIC_KEY` | *(injected by Vercel)* | Added automatically when the private Blob store is connected to the project. OIDC authentication needs no stored credential; never create `VERCEL_OIDC_TOKEN` manually. |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob token | Optional static fallback for stores that still issue long-lived credentials. |
| `CRON_SECRET` | long random secret | Unchanged — authenticates `/api/cron/cleanup`. |
| `NEXT_PUBLIC_APP_URL` | `https://your-production-domain` | Unchanged — origin checks + reset links. |
| `INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_PASSWORD` | *(optional, remove after first deploy)* | Only used by `npm run db:migrate` to bootstrap the first admin. |

`DATABASE_URL` is still honored as a fallback alias for
`TURSO_DATABASE_URL`, but the `TURSO_*` names are preferred and what
`.env.example` documents.

Run `npm run db:migrate` (locally with the prod env vars, or from CI) once
before serving traffic on the new database. Afterwards redeploy the Vercel
project — no build settings need to change (`vercel.json`, cron schedule, and
Node 20+ runtime are untouched).

---

## 5. Verification checklist (performed during this migration)

- `npm run typecheck`, `npm run lint`, `npm test` — all green.
- `npm run build` — production build succeeds.
- Local end-to-end smoke test on a `file:` libSQL database:
  migration + bootstrap admin, login/session, settings GET/PATCH (incl. the
  `ON CONFLICT (lower(name))` retention-rule upsert), categories (seed +
  duplicate → 409), user invite, API-key create, `/api/v1` bearer flow
  (verify → rate-limit upsert → request log), file metadata update inside a
  transaction with tag sync, trash transition, password-reset tokens, cron
  cleanup (lock acquire/release + summary JSON), notifications
  (read/unread + retention), audit logs, and tag usage aggregation.
