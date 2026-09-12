-- Adds the `status` column the application contract requires for every user
-- record (id, email, password_hash, role, status, created_at, updated_at,
-- last_login_at).
--
-- The original 001_initial.sql schema tracked account state with two separate
-- columns (`disabled` and `deleted_at`) and never exposed a single `status`
-- value, so the admin Users API had no column to read or return.
--
-- `status` is defined as a VIRTUAL generated column derived from the existing
-- source-of-truth columns rather than a second, independently written column:
--
--   * It can never drift out of sync with `disabled` / `deleted_at`. A plain
--     column would require every future writer to remember a dual write, and
--     the first one that forgets silently corrupts account state.
--   * Existing rows are backfilled automatically and correctly the moment the
--     migration runs; there is no separate UPDATE backfill to get wrong.
--   * SQLite only supports adding VIRTUAL (not STORED) generated columns via
--     ALTER TABLE, which is what an in-place migration on a live Turso
--     database requires.
--
-- It behaves like any other column for reads: it is selectable, indexable and
-- works with RETURNING. Writes must target `disabled` / `deleted_at`; SQLite
-- rejects direct INSERT/UPDATE of a generated column, which is the desired
-- safety property.
ALTER TABLE users ADD COLUMN status text GENERATED ALWAYS AS (
  CASE
    WHEN deleted_at IS NOT NULL THEN 'deleted'
    WHEN disabled = 1 THEN 'disabled'
    ELSE 'active'
  END
) VIRTUAL;

CREATE INDEX IF NOT EXISTS users_status_idx ON users(status) WHERE deleted_at IS NULL;
