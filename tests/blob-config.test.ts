import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

describe("Vercel Blob store configuration", () => {
  const envKeys = ["BLOB_READ_WRITE_TOKEN", "BLOB_STORE_ID", "VERCEL_OIDC_TOKEN"] as const;
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

  it("explains missing BLOB_STORE_ID when only OIDC is present", async () => {
    process.env.VERCEL_OIDC_TOKEN = "oidc-token";
    const { readBlobStoreConfig } = await import("@/lib/env");
    const read = readBlobStoreConfig();
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("expected missing store id");
    expect(read.error).toContain("BLOB_STORE_ID");
  });
});
