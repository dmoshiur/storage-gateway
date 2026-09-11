CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS roles (
  name text PRIMARY KEY CHECK (name IN ('admin', 'editor', 'viewer')),
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO roles (name, description) VALUES
  ('admin', 'Full platform administration'),
  ('editor', 'Upload and manage documents'),
  ('viewer', 'Read-only document access')
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text NOT NULL,
  display_name text,
  role text NOT NULL REFERENCES roles(name) DEFAULT 'viewer',
  disabled boolean NOT NULL DEFAULT false,
  email_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  deleted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (lower(email)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS users_role_idx ON users(role) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  ip_address inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_active_idx ON sessions(token_hash, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX IF NOT EXISTS password_reset_active_idx ON password_reset_tokens(token_hash, expires_at) WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  description text NOT NULL DEFAULT '',
  color text NOT NULL DEFAULT 'slate',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_path text NOT NULL UNIQUE,
  upload_key text,
  original_name text NOT NULL,
  title text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT '',
  tags text[] NOT NULL DEFAULT '{}',
  mime_type text NOT NULL DEFAULT 'application/pdf' CHECK (mime_type = 'application/pdf'),
  extension text NOT NULL DEFAULT 'pdf' CHECK (extension = 'pdf'),
  size_bytes bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  content_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  uploaded_by text,
  is_favorite boolean NOT NULL DEFAULT false,
  auto_delete_enabled boolean NOT NULL DEFAULT false,
  retention_type text NOT NULL DEFAULT 'never',
  custom_delete_at timestamptz,
  delete_at timestamptz,
  status text NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading','active','trash','deleting','deleted','failed')),
  deleted_at timestamptz,
  deleted_by text,
  permanent_delete_at timestamptz,
  permanently_deleted_at timestamptz,
  deletion_started_at timestamptz,
  deletion_previous_status text CHECK (deletion_previous_status IS NULL OR deletion_previous_status IN ('active','trash')),
  deletion_reason text,
  upload_expires_at timestamptz,
  validated_at timestamptz,
  last_accessed_at timestamptz,
  last_downloaded_at timestamptz,
  failure_code text,
  version integer NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS files_status_created_idx ON files(status, created_at DESC);
CREATE INDEX IF NOT EXISTS files_status_delete_idx ON files(status, delete_at);
CREATE INDEX IF NOT EXISTS files_trash_expiry_idx ON files(status, permanent_delete_at);
CREATE INDEX IF NOT EXISTS files_hash_idx ON files(content_hash) WHERE content_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS files_tags_idx ON files USING gin(tags);

CREATE TABLE IF NOT EXISTS file_tags (
  file_id uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (file_id, tag_id)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('bridge','bearer')),
  key_id text NOT NULL UNIQUE,
  secret_hash text NOT NULL,
  name text NOT NULL DEFAULT 'Untitled key',
  description text NOT NULL DEFAULT '',
  scopes text[] NOT NULL DEFAULT '{}',
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  rotated_from_id uuid REFERENCES api_keys(id) ON DELETE SET NULL,
  rotated_to_id uuid REFERENCES api_keys(id) ON DELETE SET NULL,
  prefix text NOT NULL DEFAULT '',
  legacy_hash text
);
CREATE INDEX IF NOT EXISTS api_keys_secret_idx ON api_keys(secret_hash);
CREATE INDEX IF NOT EXISTS api_keys_kind_idx ON api_keys(kind, created_at DESC);

CREATE TABLE IF NOT EXISTS api_request_logs (
  id bigserial PRIMARY KEY,
  key_id text NOT NULL,
  method text NOT NULL,
  path text NOT NULL,
  status_code integer,
  request_id text NOT NULL,
  ip_address inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_request_logs_created_idx ON api_request_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS api_upload_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id text NOT NULL,
  filename text NOT NULL,
  size_bytes bigint NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('success','failed')),
  failure_code text,
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_upload_logs_created_idx ON api_upload_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL,
  actor_id text NOT NULL,
  actor_email text,
  actor_type text NOT NULL CHECK (actor_type IN ('admin','integration','system')),
  file_id uuid,
  file_name text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_actor_idx ON audit_logs(actor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS retention_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  retention_type text NOT NULL,
  days integer,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  link text,
  dedupe_key text,
  read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_created_idx ON notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications(read, created_at DESC);

CREATE TABLE IF NOT EXISTS system_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO system_settings(key, value) VALUES (
  'app',
  '{"maxPdfSizeBytes":52428800,"storageLimitBytes":10737418240,"defaultAutoDelete":false,"defaultRetentionType":"6_months","trashEnabled":true,"trashRetentionDays":30,"signedUrlExpirySeconds":600,"warningThresholdPercent":80,"criticalThresholdPercent":90}'::jsonb
) ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS cleanup_lock (
  id boolean PRIMARY KEY DEFAULT true CHECK (id = true),
  state text NOT NULL DEFAULT 'idle',
  started_at timestamptz,
  completed_at timestamptz,
  last_summary jsonb,
  last_error text
);
INSERT INTO cleanup_lock (id, state) VALUES (true, 'idle') ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS rate_limits (
  key text PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  url text NOT NULL,
  events text[] NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  secret text NOT NULL,
  last_triggered_at timestamptz,
  last_status text CHECK (last_status IS NULL OR last_status IN ('success','failed')),
  failure_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id uuid NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event text NOT NULL,
  status text NOT NULL CHECK (status IN ('success','failed')),
  status_code integer,
  duration_ms integer NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_idx ON webhook_deliveries(webhook_id, created_at DESC);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
