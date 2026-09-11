-- API secrets are one-way digests. Older development schemas briefly included
-- a reversible encrypted copy for HMAC signing; remove it before production.
ALTER TABLE api_keys DROP COLUMN IF EXISTS secret_encrypted;
ALTER TABLE files DROP COLUMN IF EXISTS blob_url;
