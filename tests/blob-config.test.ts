import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

describe("Vercel Blob store configuration", () => {
  const envKeys = [
    "BLOB_READ_WRITE_TOKEN",
    "BLOB_STORE_ID",
    "BLOB_WEBHOOK_PUBLIC_KEY",
    "VERCEL_OIDC_TOKEN",
    "TBLOB_STORE_ID",
    "TBLOB_WEBHOOK_PUBLIC_KEY",
    "TBLOB_READ_WRITE_TOKEN",
    "T_BLOB_STORE_ID",
    "T_BLOB_WEBHOOK_PUBLIC_KEY",
    "T_BLOB_READ_WRITE_TOKEN",
    "T_STORE_ID",
    "T_WEBHOOK_PUBLIC_KEY",
    "T_READ_WRITE_TOKEN",
  ] as const;
  const snapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.resetModules();
    for (const key of envKeys) {
      snapshot[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(async () => {
    for (const key of envKeys) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
    vi.resetModules();
  });

  it("reports an exact error when no Blob token or OIDC is present", async () => {
    const { readBlobStoreConfig, getBlobStoreConfig } = await import("@/lib/env");
    const read = readBlobStoreConfig();
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("expected missing config");
    expect(read.error).toContain("Vercel Blob Private Store is not connected");
    expect(read.error).not.toMatch(/isn't configured yet/i);
    expect(read.error).not.toMatch(/is not configured yet/i);

    try {
      getBlobStoreConfig();
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toMatchObject({ code: "SERVICE_CONFIGURATION_ERROR" });
      expect((error as Error).message).toContain("Vercel Blob Private Store is not connected");
    }
  });

  it("accepts BLOB_READ_WRITE_TOKEN from the Vercel Blob integration", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_test_token";
    const { readBlobStoreConfig, getBlobStoreConfig } = await import("@/lib/env");
    const read = readBlobStoreConfig();
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error("expected ok");
    expect(read.authMode).toBe("token");
    expect(getBlobStoreConfig().token).toBe("vercel_blob_rw_test_token");
  });

  it("accepts Vercel OIDC plus BLOB_STORE_ID without a static token", async () => {
    process.env.VERCEL_OIDC_TOKEN = "oidc-token";
    process.env.BLOB_STORE_ID = "store_private_pdfs";
    const { readBlobStoreConfig } = await import("@/lib/env");
    const read = readBlobStoreConfig();
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error("expected ok");
    expect(read.authMode).toBe("oidc");
    expect(read.storeId).toBe("store_private_pdfs");
  });

  it("accepts clean BLOB_STORE_ID and BLOB_WEBHOOK_PUBLIC_KEY without any prefix", async () => {
    process.env.BLOB_STORE_ID = "store_clean123";
    process.env.BLOB_WEBHOOK_PUBLIC_KEY = "key_clean456";
    const { readBlobStoreConfig, getBlobStoreConfig } = await import("@/lib/env");
    const read = readBlobStoreConfig();
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error("expected ok");
    expect(read.authMode).toBe("oidc");
    expect(read.storeId).toBe("store_clean123");
    expect(read.webhookPublicKey).toBe("key_clean456");
    expect(getBlobStoreConfig().storeId).toBe("store_clean123");
    expect(getBlobStoreConfig().webhookPublicKey).toBe("key_clean456");
  });

  it("accepts BLOB_STORE_ID alone without static VERCEL_OIDC_TOKEN in env", async () => {
    process.env.BLOB_STORE_ID = "store_private_pdfs";
    const { readBlobStoreConfig, getBlobStoreConfig } = await import("@/lib/env");
    const read = readBlobStoreConfig();
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error("expected ok");
    expect(read.authMode).toBe("oidc");
    expect(read.storeId).toBe("store_private_pdfs");
    expect(getBlobStoreConfig().storeId).toBe("store_private_pdfs");
  });

  it("accepts Vercel automated prefixed TBLOB_STORE_ID and TBLOB_WEBHOOK_PUBLIC_KEY", async () => {
    process.env.TBLOB_STORE_ID = "store_test123";
    process.env.TBLOB_WEBHOOK_PUBLIC_KEY = "key_test456";
    const { readBlobStoreConfig, getBlobStoreConfig } = await import("@/lib/env");
    const read = readBlobStoreConfig();
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error("expected ok");
    expect(read.authMode).toBe("oidc");
    expect(read.storeId).toBe("store_test123");
    expect(read.webhookPublicKey).toBe("key_test456");
    expect(getBlobStoreConfig().storeId).toBe("store_test123");
    expect(process.env.BLOB_STORE_ID).toBe("store_test123");
    expect(process.env.BLOB_WEBHOOK_PUBLIC_KEY).toBe("key_test456");
  });

  it("accepts underscore-prefixed T_BLOB_STORE_ID and T_BLOB_WEBHOOK_PUBLIC_KEY", async () => {
    process.env.T_BLOB_STORE_ID = "store_test789";
    process.env.T_BLOB_WEBHOOK_PUBLIC_KEY = "key_test789";
    const { readBlobStoreConfig, getBlobStoreConfig } = await import("@/lib/env");
    const read = readBlobStoreConfig();
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error("expected ok");
    expect(read.authMode).toBe("oidc");
    expect(read.storeId).toBe("store_test789");
    expect(read.webhookPublicKey).toBe("key_test789");
    expect(getBlobStoreConfig().storeId).toBe("store_test789");
  });

  it("accepts prefixed read-write token TBLOB_READ_WRITE_TOKEN", async () => {
    process.env.TBLOB_READ_WRITE_TOKEN = "vercel_blob_rw_store_abc_secret";
    const { readBlobStoreConfig, getBlobStoreConfig } = await import("@/lib/env");
    const read = readBlobStoreConfig();
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error("expected ok");
    expect(read.authMode).toBe("token");
    expect(read.token).toBe("vercel_blob_rw_store_abc_secret");
    expect(getBlobStoreConfig().token).toBe("vercel_blob_rw_store_abc_secret");
    expect(process.env.BLOB_READ_WRITE_TOKEN).toBe("vercel_blob_rw_store_abc_secret");
  });

  it("explains missing BLOB_STORE_ID when only OIDC is present", async () => {
    process.env.VERCEL_OIDC_TOKEN = "oidc-token";
    const { readBlobStoreConfig } = await import("@/lib/env");
    const read = readBlobStoreConfig();
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("expected missing store id");
    expect(read.error).toContain("BLOB_STORE_ID");
  });
});
