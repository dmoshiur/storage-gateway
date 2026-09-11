import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { blobSdkAuthOptions, describeBlobStoreConfiguration, readBlobStoreConfig } from "@/lib/env";

/**
 * Regression tests for the Vercel Private Blob authentication configuration.
 *
 * THE PRODUCTION FAILURE THIS COVERS:
 * A Blob store connected with OIDC adds exactly two environment variables to the
 * project — `BLOB_STORE_ID` and `BLOB_WEBHOOK_PUBLIC_KEY`. The OIDC token is NOT
 * a stored environment variable: Vercel delivers it per request on the
 * `x-vercel-oidc-token` header and `@vercel/blob` resolves it through
 * `@vercel/oidc`.
 *
 * The previous resolver only accepted OIDC when `process.env.VERCEL_OIDC_TOKEN`
 * was also set, so a correctly-connected production store was reported as
 * "not configured" (503 BLOB_NOT_CONFIGURED → "Blob unavailable") on every
 * upload, preview, download and delete.
 */

const BLOB_VARIABLES = [
  "BLOB_READ_WRITE_TOKEN",
  "BLOB_STORE_ID",
  "BLOB_WEBHOOK_PUBLIC_KEY",
  "BLOB_WEBHOOK_KEY",
  "VERCEL_OIDC_TOKEN",
  "VERCEL",
  "VERCEL_ENV",
] as const;

const original = Object.fromEntries(BLOB_VARIABLES.map((name) => [name, process.env[name]]));

function setEnvironment(values: Partial<Record<(typeof BLOB_VARIABLES)[number], string>>) {
  for (const name of BLOB_VARIABLES) delete process.env[name];
  for (const [name, value] of Object.entries(values)) if (value !== undefined) process.env[name] = value;
}

afterEach(() => {
  for (const name of BLOB_VARIABLES) {
    const value = original[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("Vercel Private Blob configuration", () => {
  describe("OIDC-only production store (the reported failure)", () => {
    beforeEach(() => {
      // Exactly what Vercel injects for a connected OIDC store: no static token,
      // no VERCEL_OIDC_TOKEN in the environment.
      setEnvironment({
        BLOB_STORE_ID: "store_prod123",
        BLOB_WEBHOOK_PUBLIC_KEY: "-----BEGIN PUBLIC KEY-----test-----END PUBLIC KEY-----",
        VERCEL: "1",
        VERCEL_ENV: "production",
      });
    });

    it("reports the store as configured", () => {
      const config = readBlobStoreConfig();
      expect(config.ok).toBe(true);
      expect(config.error).toBeNull();
      expect(config.missing).toEqual([]);
    });

    it("resolves the OIDC auth mode and the store id", () => {
      const config = readBlobStoreConfig();
      expect(config.authMode).toBe("oidc");
      expect(config.storeId).toBe("store_prod123");
      expect(config.storeIdSource).toBe("BLOB_STORE_ID");
      expect(config.onVercel).toBe(true);
      expect(config.vercelEnv).toBe("production");
    });

    it("hands the SDK the store id and never a stale explicit OIDC token", () => {
      // Passing a token read from the environment disables the SDK's automatic
      // refresh; the SDK must resolve it from the request context instead.
      const options = blobSdkAuthOptions();
      expect(options.storeId).toBe("store_prod123");
      expect(options.token).toBeUndefined();
      expect(Object.keys(options)).not.toContain("oidcToken");
    });
  });

  it("treats a static read-write token as a complete configuration", () => {
    setEnvironment({ BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_abc123def456_secret", VERCEL: "1", VERCEL_ENV: "production" });
    const config = readBlobStoreConfig();
    expect(config.ok).toBe(true);
    expect(config.authMode).toBe("token");
    expect(config.storeId).toBe("abc123def456");
    expect(config.storeIdSource).toBe("BLOB_READ_WRITE_TOKEN");
    expect(blobSdkAuthOptions().token).toBe("vercel_blob_rw_abc123def456_secret");
  });

  it("lists the exact missing variables when nothing is configured", () => {
    setEnvironment({});
    const config = readBlobStoreConfig();
    expect(config.ok).toBe(false);
    expect(config.authMode).toBe("none");
    expect(config.missing).toEqual(["BLOB_STORE_ID", "BLOB_READ_WRITE_TOKEN"]);
    expect(config.error).toContain("BLOB_STORE_ID");
    expect(config.error).toContain("BLOB_READ_WRITE_TOKEN");
    // The message must be actionable, not a bare "unavailable".
    expect(config.error).toMatch(/Connect a private Blob store to this Vercel project/i);
  });

  it("warns when a stale VERCEL_OIDC_TOKEN is stored in a Vercel project", () => {
    setEnvironment({
      BLOB_STORE_ID: "store_prod123",
      VERCEL_OIDC_TOKEN: "stale.jwt.token",
      VERCEL: "1",
      VERCEL_ENV: "production",
    });
    const config = readBlobStoreConfig();
    expect(config.ok).toBe(true);
    expect(config.oidcTokenInEnv).toBe(true);
    expect(config.warnings.join(" ")).toMatch(/Remove VERCEL_OIDC_TOKEN/);
  });

  it("warns when running outside Vercel without any OIDC token available", () => {
    setEnvironment({ BLOB_STORE_ID: "store_prod123" });
    const config = readBlobStoreConfig();
    expect(config.ok).toBe(true);
    expect(config.onVercel).toBe(false);
    expect(config.warnings.join(" ")).toMatch(/vercel env pull/);
  });

  it("never exposes credential values in the serializable diagnostics", () => {
    setEnvironment({
      BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_abc123def456_super-secret",
      BLOB_WEBHOOK_PUBLIC_KEY: "-----BEGIN PUBLIC KEY-----secretish",
      VERCEL: "1",
    });
    const diagnostics = describeBlobStoreConfiguration();
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("secretish");
    expect(diagnostics.hasReadWriteToken).toBe(true);
    expect(diagnostics.hasWebhookPublicKey).toBe(true);
    expect(diagnostics.storeId).toBe("abc123def456");
  });
});
