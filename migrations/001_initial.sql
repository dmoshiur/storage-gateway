-- Turso (libSQL/SQLite) initial schema.
--
-- Consolidates the former PostgreSQL migrations 001–004 into a single
-- SQLite-dialect schema for fresh Turso databases:
--   * 001_initial.sql                       → table + index definitions
--   * 002_remove_reversible_api_secrets.sql → legacy columns are never created
--   * 003_seed_default_retention_rule.sql   → retention_rules name index + seed
--   * 004_enforce_private_pdf_metadata.sql  → PDF CHECK constraints (GLOB form)
--
-- Type mapping used throughout (SQLite has dynamic typing; these are the
-- canonical forms the application code expects):
--   PostgreSQL uuid        → text PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || '4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))))
--   PostgreSQL timestamptz → text, ISO-8601 UTC (`2026-01-31T12:00:00.000Z`);
--                            DEFAULT strftime('%Y-%m-%dT%H:%M:%fZ','now') which
--                            matches JavaScript `new Date().toISOString()`.
--   PostgreSQL boolean     → integer 0/1
--   PostgreSQL text[]      → text holding a JSON array (`["a","b"]`)
--   PostgreSQL jsonb       → text holding a JSON document
--   PostgreSQL inet        → text

CREATE TABLE IF NOT EXISTS roles (
  name text PRIMARY KEY CHECK (name IN ('admin', 'editor', 'viewer')),
  description text NOT NULL DEFAULT '',
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT INTO roles (name, description) VALUES
  ('admin', 'Full platform administration'),
  ('editor', 'Upload and manage documents'),
  ('viewer', 'Read-only document access')
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || '4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  email text NOT NULL,
  password_hash text NOT NULL,
  display_name text,
  role text NOT NULL REFERENCES roles(name) DEFAULT 'viewer',
  disabled integer NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  email_verified_at text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_login_at text,
  deleted_at text
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (lower(email)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS users_role_idx ON users(role) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || '4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  ip_address text,
  user_agent text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_used_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at text NOT NULL,
  revoked_at text
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_active_idx ON sessions(token_hash, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id text PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || '4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at text NOT NULL,
  used_at text
);
CREATE INDEX IF NOT EXISTS password_reset_active_idx ON password_reset_tokens(token_hash, expires_at) WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS categories (
  id text PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || '4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  name text NOT NULL UNIQUE,
  description text NOT NULL DEFAULT '',
  color text NOT NULL DEFAULT 'slate',
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS tags (
  id text PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || '4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  name text NOT NULL UNIQUE,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS files (
  id text PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || '4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  storage_path text NOT NULL UNIQUE,
  upload_key text,
  original_name text NOT NULL,
  title text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT '',
  tags text NOT NULL DEFAULT '[]',
  mime_type text NOT NULL DEFAULT 'application/pdf' CHECK (mime_type = 'application/pdf'),
  extension text NOT NULL DEFAULT 'pdf' CHECK (extension = 'pdf'),
  size_bytes integer NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  content_hash text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  uploaded_by text,
  is_favorite integer NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
  auto_delete_enabled integer NOT NULL DEFAULT 0 CHECK (auto_delete_enabled IN (0, 1)),
  retention_type text NOT NULL DEFAULT 'never',
  custom_delete_at text,
  delete_at text,
  status text NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading','active','trash','deleting','deleted','failed')),
  deleted_at text,
  deleted_by text,
  permanent_delete_at text,
  permanently_deleted_at text,
  deletion_started_at text,
  deletion_previous_status text CHECK (deletion_previous_status IS NULL OR deletion_previous_status IN ('active','trash')),
  deletion_reason text,
  upload_expires_at text,
  validated_at text,
  last_accessed_at text,
  last_downloaded_at text,
  failure_code text,
  version integer NOT NULL DEFAULT 1,
  CHECK (storage_path GLOB 'pdfs/[0-9][0-9][0-9][0-9]/[0-9][0-9]/[A-Za-z0-9_-]*.pdf')
);
CREATE INDEX IF NOT EXISTS files_status_created_idx ON files(status, created_at DESC);
CREATE INDEX IF NOT EXISTS files_status_delete_idx ON files(status, delete_at);
CREATE INDEX IF NOT EXISTS files_trash_expiry_idx ON files(status, permanent_delete_at);
CREATE INDEX IF NOT EXISTS files_hash_idx ON files(content_hash) WHERE content_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS file_tags (
  file_id text NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  tag_id text NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (file_id, tag_id)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id text PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || '4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  kind text NOT NULL CHECK (kind IN ('bridge','bearer')),
  key_id text NOT NULL UNIQUE,
  secret_hash text NOT NULL,
  name text NOT NULL DEFAULT 'Untitled key',
  description text NOT NULL DEFAULT '',
  scopes text NOT NULL DEFAULT '[]',
  expires_at text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_used_at text,
  revoked_at text,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  rotated_from_id text REFERENCES api_keys(id) ON DELETE SET NULL,
  rotated_to_id text REFERENCES api_keys(id) ON DELETE SET NULL,
  prefix text NOT NULL DEFAULT '',
  legacy_hash text
);
CREATE INDEX IF NOT EXISTS api_keys_secret_idx ON api_keys(secret_hash);
CREATE INDEX IF NOT EXISTS api_keys_kind_idx ON api_keys(kind, created_at DESC);

CREATE TABLE IF NOT EXISTS api_request_logs (
  id integer PRIMARY KEY AUTOINCREMENT,
  key_id text NOT NULL,
  method text NOT NULL,
  path text NOT NULL,
  status_code integer,
  request_id text NOT NULL,
  ip_address text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS api_request_logs_created_idx ON api_request_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS api_upload_logs (
  id text PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || '4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  key_id text NOT NULL,
  filename text NOT NULL,
  size_bytes integer NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('success','failed')),
  failure_code text,
  request_id text NOT NULL,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS api_upload_logs_created_idx ON api_upload_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id text PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || '4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  action text NOT NULL,
  actor_id text NOT NULL,
  actor_email text,
  actor_type text NOT NULL CHECK (actor_type IN ('admin','integration','system')),
  file_id text,
  file_name text,
  details text NOT NULL DEFAULT '{}',
  request_id text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_actor_idx ON audit_logs(actor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS retention_rules (
  id text PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || '4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  name text NOT NULL,
  enabled integer NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  retention_type text NOT NULL,
  days integer,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- Case-insensitive rule names (replaces PostgreSQL's lower(name) unique index
-- and powers the ON CONFLICT (lower(name)) upsert in the settings module).
CREATE UNIQUE INDEX IF NOT EXISTS retention_rules_name_unique ON retention_rules (lower(name));

INSERT INTO retention_rules(name, enabled, retention_type, days)
VALUES ('default', 1, '6_months', 180)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS notifications (
  id text PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || '4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  type text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  link text,
  dedupe_key text,
  read integer NOT NULL DEFAULT 0 CHECK (read IN (0, 1)),
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS notifications_created_idx ON notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications(read, created_at DESC);

CREATE TABLE IF NOT EXISTS system_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by text REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO system_settings(key, value) VALUES (
  'app',
  '{"maxPdfSizeBytes":52428800,"storageLimitBytes":10737418240,"defaultAutoDelete":false,"defaultRetentionType":"6_months","trashEnabled":true,"trashRetentionDays":30,"signedUrlExpirySeconds":600,"warningThresholdPercent":80,"criticalThresholdPercent":90}'
) ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS cleanup_lock (
  id integer PRIMARY KEY CHECK (id = 1),
  state text NOT NULL DEFAULT 'idle',
  started_at text,
  completed_at text,
  last_summary text,
  last_error text
);
INSERT INTO cleanup_lock (id, state) VALUES (1, 'idle') ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS rate_limits (
  key text PRIMARY KEY,
  window_started_at text NOT NULL,
  request_count integer NOT NULL DEFAULT 0,
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS webhooks (
  id text PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || '4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  name text NOT NULL,
  url text NOT NULL,
  events text NOT NULL DEFAULT '[]',
  enabled integer NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  secret text NOT NULL,
  last_triggered_at text,
  last_status text CHECK (last_status IS NULL OR last_status IN ('success','failed')),
  failure_count integer NOT NULL DEFAULT 0,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by text REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id text PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || '4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  webhook_id text NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event text NOT NULL,
  status text NOT NULL CHECK (status IN ('success','failed')),
  status_code integer,
  duration_ms integer NOT NULL DEFAULT 0,
  error text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_idx ON webhook_deliveries(webhook_id, created_at DESC);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
