import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Regression guard for Blob environment resolution.
 *
 * Resolution used to scan every variable in `process.env` with loose patterns
 * (`^(?:.*_)?STORE_ID$`, `^(?:.*_)?OIDC_TOKEN$`), so an unrelated `S3_STORE_ID`
 * or the `GITHUB_OIDC_TOKEN` that GitHub Actions injects was silently adopted as
 * Vercel Blob configuration. These tests pin the allowlist behaviour and prove
 * the normalization block cannot touch non-Blob configuration.
 */
describe("Blob environment resolution is isolated from the rest of the environment", () => {
  const coreVars = [
    "FIREBASE_PROJECT_ID",
    "FIREBASE_CLIENT_EMAIL",
    "FIREBASE_PRIVATE_KEY",
    "ADMIN_PASS",
    "ADMIN_EMAILS",
    "INTEGRATION_API_KEY",
    "CRON_SECRET",
    "AM_STORAGE_MASTER_KEY",
    "AM_STORAGE_KEYS",
    "AM_STORAGE_MAX_DOCUMENT_BYTES",
    "NEXT_PUBLIC_APP_URL",
    "PATH",
  ];

  const blobVars = [
    "BLOB_READ_WRITE_TOKEN",
    "BLOB_STORE_ID",
    "BLOB_WEBHOOK_PUBLIC_KEY",
    "VERCEL_OIDC_TOKEN",
    "OIDC_TOKEN",
    "TBLOB_STORE_ID",
    "TBLOB_READ_WRITE_TOKEN",
    "TBLOB_WEBHOOK_PUBLIC_KEY",
    "T_BLOB_STORE_ID",
    "T_READ_WRITE_TOKEN",
    "T_STORE_ID",
    "T_WEBHOOK_PUBLIC_KEY",
    "MYAPP_BLOB_STORE_ID",
    "S3_STORE_ID",
    "AWS_READ_WRITE_TOKEN",
    "GITHUB_OIDC_TOKEN",
    "LEGACY_UPLOAD_TOKEN",
    "OTHERAPP_BLOB_STORE_ID",
  ];

  const snapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.resetModules();
    for (const key of [...blobVars, ...coreVars]) {
      snapshot[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of Object.keys(snapshot)) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
    vi.resetModules();
  });

  it("never reads, overwrites, or deletes non-Blob backend configuration", async () => {
    for (const key of coreVars) process.env[key] = `core-value-for-${key}`;
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_store_real.token.sig";

    const { readBlobStoreConfig } = await import("@/lib/env");
    readBlobStoreConfig();

    for (const key of coreVars) {
      expect(process.env[key], `${key} must be untouched`).toBe(`core-value-for-${key}`);
    }
  });

  it("does not adopt an unrelated *_STORE_ID as the Blob store", async () => {
    process.env.S3_STORE_ID = "store_unrelated_s3";
    const { readBlobStoreConfig } = await import("@/lib/env");
    const config = readBlobStoreConfig();
    expect(config.ok).toBe(false);
    if (config.ok) throw new Error("expected unconfigured");
    expect(config.storeId).toBeNull();
    expect(process.env.BLOB_STORE_ID).toBeUndefined();
  });

  it("does not adopt an unrelated *_OIDC_TOKEN as the Vercel OIDC token", async () => {
    process.env.GITHUB_OIDC_TOKEN = "github-actions-oidc-jwt";
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_store_real.token.sig";
    const { readBlobStoreConfig } = await import("@/lib/env");
    const config = readBlobStoreConfig();
    expect(config.ok).toBe(true);
    if (!config.ok) throw new Error("expected ok");
    expect(config.oidcToken).toBeNull();
  });

  it("does not adopt an unrelated *_READ_WRITE_TOKEN", async () => {
    process.env.AWS_READ_WRITE_TOKEN = "aws-some-other-token";
    const { readBlobStoreConfig } = await import("@/lib/env");
    expect(readBlobStoreConfig().ok).toBe(false);
  });

  it("accepts the documented Vercel-injected and prefixed variants", async () => {
    const cases: Array<[string, string]> = [
      ["TBLOB_STORE_ID", "store_prefixed_a"],
      ["T_BLOB_STORE_ID", "store_prefixed_b"],
      ["T_STORE_ID", "store_prefixed_c"],
      ["MYAPP_BLOB_STORE_ID", "store_prefixed_d"],
    ];
    for (const [key, value] of cases) {
      for (const name of blobVars) delete process.env[name];
      process.env[key] = value;
      vi.resetModules();
      const { readBlobStoreConfig } = await import("@/lib/env");
      const config = readBlobStoreConfig();
      expect(config.ok, `${key} should be accepted`).toBe(true);
      if (!config.ok) throw new Error("expected ok");
      expect(config.storeId, key).toBe(value);
      expect(config.sources?.storeId, key).toBe(key);
    }
  });

  it("never hands one concept's variable to another concept", async () => {
    // A store id must not be resolved as the read-write token, and a token must
    // not be resolved as the store id.
    process.env.BLOB_STORE_ID = "store_only_a_store_id";
    const { readBlobStoreConfig } = await import("@/lib/env");
    const config = readBlobStoreConfig();
    if (!config.ok) throw new Error("expected ok");
    expect(config.authMode).toBe("oidc");
    expect(config.storeId).toBe("store_only_a_store_id");
    expect(config.token).toBeNull();
    expect(config.sources?.token).toBeUndefined();
    expect(config.sources?.storeId).toBe("BLOB_STORE_ID");
  });

  it("prefers the canonical name over a prefixed variant", async () => {
    process.env.BLOB_STORE_ID = "store_canonical";
    process.env.TBLOB_STORE_ID = "store_prefixed";
    const { readBlobStoreConfig } = await import("@/lib/env");
    const config = readBlobStoreConfig();
    if (!config.ok) throw new Error("expected ok");
    expect(config.storeId).toBe("store_canonical");
  });

  it("resolves the same variable regardless of environment insertion order", async () => {
    process.env.MYAPP_BLOB_STORE_ID = "store_from_myapp";
    process.env.OTHERAPP_BLOB_STORE_ID = "store_from_otherapp";
    const { readBlobStoreConfig } = await import("@/lib/env");
    const config = readBlobStoreConfig();
    if (!config.ok) throw new Error("expected ok");
    // Sorted key order makes the winner stable across processes/deploys.
    expect(config.storeId).toBe("store_from_myapp");
    expect(config.sources?.storeId).toBe("MYAPP_BLOB_STORE_ID");
  });

  it("never overwrites a canonical value an operator already set", async () => {
    process.env.BLOB_STORE_ID = "store_explicitly_set";
    process.env.TBLOB_STORE_ID = "store_from_prefixed_var";
    const { readBlobStoreConfig } = await import("@/lib/env");
    const config = readBlobStoreConfig();
    if (!config.ok) throw new Error("expected ok");
    expect(config.storeId).toBe("store_explicitly_set");
    expect(process.env.BLOB_STORE_ID).toBe("store_explicitly_set");
  });

  it("still recovers a read-write token kept under a legacy name", async () => {
    process.env.LEGACY_UPLOAD_TOKEN = "vercel_blob_rw_store_legacy.token.sig";
    const { readBlobStoreConfig } = await import("@/lib/env");
    const config = readBlobStoreConfig();
    if (!config.ok) throw new Error("expected ok");
    expect(config.authMode).toBe("token");
    expect(config.token).toBe("vercel_blob_rw_store_legacy.token.sig");
    expect(config.sources?.token).toBe("LEGACY_UPLOAD_TOKEN");
  });
});
