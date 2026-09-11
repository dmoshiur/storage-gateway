import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { VercelBlobStorageService } from "@/lib/storage/vercel-blob";
import { readBlobStoreConfig } from "@/lib/env";
import { createBlobEmulator } from "./helpers/blob-emulator.mjs";

/**
 * Integration tests for the Vercel Private Blob adapter.
 *
 * The adapter under test is the real production code. `@vercel/blob` performs
 * real HTTP requests, but they are pointed at the test-only Blob API emulator
 * (`tests/helpers/blob-emulator.mjs`) through the SDK's documented
 * `VERCEL_BLOB_API_URL` override, because this environment has no Vercel
 * credentials and no outbound network. Nothing in `src/` knows the emulator
 * exists; a deployment always talks to https://vercel.com/api/blob.
 *
 * Authentication is exercised the way Vercel Functions actually deliver it:
 * the OIDC token is placed on the request context
 * (`x-vercel-oidc-token` header) exactly as the Vercel runtime does, with
 * `process.env.VERCEL_OIDC_TOKEN` left unset — the configuration that broke
 * production.
 */

const STORE_ID = "store_test";
// The SDK normalizes `store_<id>` to `<id>` when it builds Blob hostnames/headers.
const NORMALIZED_STORE_ID = "test";
const OBJECT_HOST = `${NORMALIZED_STORE_ID}.private.blob.vercel-storage.com`;

/** A structurally valid, unexpired OIDC JWT (never a real credential). */
function fakeOidcToken(expiresInSeconds = 3600): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: "owner:team:project:app:environment:production", exp: Math.floor(Date.now() / 1000) + expiresInSeconds })).toString("base64url");
  return `${header}.${payload}.test-signature`;
}

const REQUEST_CONTEXT = Symbol.for("@vercel/request-context");

function installVercelRequestContext(token: string) {
  (globalThis as unknown as Record<symbol, unknown>)[REQUEST_CONTEXT] = {
    get: () => ({ headers: { "x-vercel-oidc-token": token } }),
  };
}

function clearVercelRequestContext() {
  delete (globalThis as unknown as Record<symbol, unknown>)[REQUEST_CONTEXT];
}

/** The SDK only accepts object URLs on *.blob.vercel-storage.com. */
function objectHostIsLocal(): boolean {
  try {
    return readFileSync("/etc/hosts", "utf8").includes(`${OBJECT_HOST}`);
  } catch {
    return false;
  }
}

const objectHostMapped = objectHostIsLocal();

const PDF_BYTES = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
  "utf8",
);

const ENV_NAMES = ["BLOB_STORE_ID", "BLOB_READ_WRITE_TOKEN", "BLOB_WEBHOOK_PUBLIC_KEY", "VERCEL_OIDC_TOKEN", "VERCEL", "VERCEL_ENV", "VERCEL_BLOB_API_URL", "VERCEL_BLOB_RETRIES"] as const;
const originalEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));

let emulator: Awaited<ReturnType<typeof createBlobEmulator>>;
const storage = new VercelBlobStorageService();

beforeAll(async () => {
  emulator = await createBlobEmulator({ storeId: STORE_ID, hostName: OBJECT_HOST });
  process.env.VERCEL_BLOB_API_URL = emulator.apiUrl;
  process.env.VERCEL_BLOB_RETRIES = "0";
  process.env.BLOB_STORE_ID = STORE_ID;
  process.env.BLOB_WEBHOOK_PUBLIC_KEY = "-----BEGIN PUBLIC KEY-----test-----END PUBLIC KEY-----";
  process.env.VERCEL = "1";
  process.env.VERCEL_ENV = "production";
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.VERCEL_OIDC_TOKEN;
  installVercelRequestContext(fakeOidcToken());
});

afterAll(async () => {
  await emulator.close();
  for (const name of ENV_NAMES) {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  clearVercelRequestContext();
});

beforeEach(() => {
  emulator.objects.clear();
  emulator.requests.length = 0;
  installVercelRequestContext(fakeOidcToken());
});

afterEach(() => {
  delete process.env.BLOB_STORE_ID;
  process.env.BLOB_STORE_ID = STORE_ID;
});

describe("Vercel Blob adapter — real SDK request flow", () => {
  it("uploads a PDF to the private pathname and stores the exact bytes", async () => {
    const pathname = "pdfs/2026/09/probe-upload.pdf";
    const result = await storage.upload({ pathname, body: PDF_BYTES, contentType: "application/pdf" });

    expect(result.pathname).toBe(pathname);
    expect(result.url).toContain(OBJECT_HOST);
    expect(emulator.objects.get(pathname)?.bytes.equals(PDF_BYTES)).toBe(true);

    const put = emulator.seen("PUT", "/api/blob");
    expect(put).toHaveLength(1);
    // Private access is asserted by the SDK request itself — PDFs are never public.
    expect(put[0].headers["x-vercel-blob-access"]).toBe("private");
    expect(put[0].headers["x-content-type"]).toBe("application/pdf");
  });

  it("authenticates with the OIDC token from the request context and the configured store id", async () => {
    const token = fakeOidcToken();
    installVercelRequestContext(token);

    await storage.upload({ pathname: "pdfs/auth-check.pdf", body: PDF_BYTES, contentType: "application/pdf" });
    await storage.healthCheck();

    const requests = emulator.requests.filter((entry) => entry.path.includes("/api/blob"));
    expect(requests.length).toBeGreaterThanOrEqual(2);
    for (const request of requests) {
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
      expect(request.headers["x-vercel-blob-store-id"]).toBe(NORMALIZED_STORE_ID);
    }
    // The store was used WITHOUT any environment OIDC token.
    expect(process.env.VERCEL_OIDC_TOKEN).toBeUndefined();
  });

  it("lists, heads and reports metadata for a stored object", async () => {
    const pathname = "pdfs/2026/09/probe-meta.pdf";
    emulator.seed(pathname, PDF_BYTES);

    expect(await storage.exists(pathname)).toBe(true);
    expect(await storage.exists("pdfs/missing.pdf")).toBe(false);

    const metadata = await storage.getMetadata(pathname);
    expect(metadata.contentLength).toBe(PDF_BYTES.byteLength);
    expect(metadata.contentType).toBe("application/pdf");
  });

  it.runIf(objectHostMapped)("downloads the full object and a byte range through the private read path", async () => {
    const pathname = "pdfs/2026/09/probe-download.pdf";
    emulator.seed(pathname, PDF_BYTES);

    const full = await storage.download(pathname);
    expect(Buffer.from(full).equals(PDF_BYTES)).toBe(true);

    const range = await storage.downloadStream(pathname, "bytes=0-7");
    const rangeBytes = Buffer.from(await new Response(range.stream).arrayBuffer());
    expect(rangeBytes.toString("utf8")).toBe("%PDF-1.4");
    expect(range.statusCode).toBe(206);
    expect(range.contentRange).toBe(`bytes 0-7/${PDF_BYTES.byteLength}`);
    expect(range.contentLength).toBe(8);

    const suffix = await storage.downloadStream(pathname, "bytes=-6");
    expect(Buffer.from(await new Response(suffix.stream).arrayBuffer()).toString("utf8")).toBe("%%EOF\n");
  });

  it.runIf(objectHostMapped)("copies and deletes objects, and deletion is idempotent", async () => {
    const source = "pdfs/2026/09/probe-copy-source.pdf";
    const destination = "pdfs/2026/09/probe-copy-destination.pdf";
    emulator.seed(source, PDF_BYTES);

    await storage.copy(source, destination);
    expect(emulator.objects.get(destination)?.bytes.equals(PDF_BYTES)).toBe(true);

    await storage.delete(source);
    expect(emulator.objects.has(source)).toBe(false);

    // Second delete must not throw.
    await storage.delete(source);
    expect(emulator.objects.has(source)).toBe(false);

    const list = emulator.seen("GET", "/api/blob");
    expect(list.length).toBeGreaterThan(0);
  });

  it("mints short-lived, single-path signed URLs without ever exposing a permanent URL", async () => {
    const pathname = "pdfs/2026/09/probe-signed.pdf";
    emulator.seed(pathname, PDF_BYTES);

    const inline = await storage.getSignedUrl(pathname, { expiresInSeconds: 300, disposition: "inline", filename: "probe.pdf" });
    const url = new URL(inline);
    expect(url.hostname).toBe(OBJECT_HOST);
    expect(url.searchParams.get("vercel-blob-delegation")).toBeTruthy();
    expect(url.searchParams.get("vercel-blob-signature")).toBeTruthy();
    expect(Number(url.searchParams.get("vercel-blob-valid-until"))).toBeLessThanOrEqual(Date.now() + 300_000);
    // The static credential is never embedded in the URL handed to a caller.
    expect(inline).not.toContain("vercel_blob_rw");

    const attachment = await storage.getSignedUrl(pathname, { expiresInSeconds: 300, disposition: "attachment", filename: "probe.pdf" });
    expect(new URL(attachment).searchParams.get("download")).toBe("1");
  });

  it("mints a presigned PUT URL constrained to application/pdf and a maximum size", async () => {
    const uploadUrl = await storage.getSignedUploadUrl("pdfs/2026/09/probe-put.pdf", {
      expiresInSeconds: 600,
      contentType: "application/pdf",
      contentLength: 4 * 1024 * 1024,
      metadata: {},
    });
    const url = new URL(uploadUrl);
    expect(url.searchParams.get("vercel-blob-allowed-content-types")).toBe("application/pdf");
    expect(Number(url.searchParams.get("vercel-blob-maximum-size-in-bytes"))).toBe(4 * 1024 * 1024);
    expect(url.searchParams.get("vercel-blob-add-random-suffix")).toBe("false");
  });
});

describe("Vercel Blob health checks", () => {
  it("reports the exact missing configuration when the store is not connected", async () => {
    const savedStoreId = process.env.BLOB_STORE_ID;
    delete process.env.BLOB_STORE_ID;
    delete process.env.BLOB_READ_WRITE_TOKEN;

    const health = await storage.healthCheck();

    expect(health.reachable).toBe(false);
    expect(health.configured).toBe(false);
    expect(health.errorCode).toBe("BLOB_NOT_CONFIGURED");
    expect(health.missingConfiguration).toEqual(["BLOB_STORE_ID", "BLOB_READ_WRITE_TOKEN"]);
    expect(health.error).toContain("BLOB_STORE_ID");
    expect(health.error).not.toBe("Blob unavailable");
    expect(readBlobStoreConfig().ok).toBe(false);

    process.env.BLOB_STORE_ID = savedStoreId;
  });

  it("reports a reachable store with the resolved auth mode", async () => {
    emulator.seed("pdfs/2026/09/existing.pdf", PDF_BYTES);
    const health = await storage.healthCheck();

    expect(health.reachable).toBe(true);
    expect(health.configured).toBe(true);
    expect(health.authMode).toBe("oidc");
    expect(health.storeId).toBe(STORE_ID);
    expect(health.probe?.operation).toBe("list");
    expect(health.error).toBeNull();
  });

  it("surfaces the real Vercel Blob access error with an operator hint", async () => {
    emulator.failNext({ status: 403, code: "forbidden", message: "Access denied" });
    const health = await storage.healthCheck();

    expect(health.reachable).toBe(false);
    expect(health.errorCode).toBe("BLOB_ACCESS_ERROR");
    expect(health.errorName).toBe("BlobAccessError");
    expect(health.error).toContain("BlobAccessError");
    expect(health.error).toContain("Access denied");
    expect(health.hint).toMatch(/connected to THIS Vercel project/i);
    expect(health.storeId).toBe(STORE_ID);
  });

  it("identifies the OIDC environment restriction precisely", async () => {
    emulator.failNext({
      status: 403,
      code: "oidc_environment_not_allowed",
      message: "OIDC is enabled for this project, but not for the preview environment.",
    });
    const health = await storage.healthCheck();

    expect(health.reachable).toBe(false);
    expect(health.errorCode).toBe("BLOB_OIDC_ENVIRONMENT_NOT_ALLOWED");
    expect(health.hint).toMatch(/Production/);
    expect(health.error).toContain("OIDC is enabled for this project");
  });

  it("performs a real write → read → delete deep probe and cleans up", async () => {
    const health = await storage.deepHealthCheck();

    expect(health.reachable).toBe(true);
    expect(health.deepCheck?.ok).toBe(true);
    expect(health.deepCheck?.cleanedUp).toBe(true);
    expect(health.deepCheck?.steps.map((step) => step.step)).toEqual(["put", "head", "get", "delete"]);
    expect(health.deepCheck?.steps.every((step) => step.ok)).toBe(true);
    // The probe object must not linger in the private store.
    expect([...emulator.objects.keys()].some((pathname) => pathname.startsWith("health/"))).toBe(false);
  });

  it("reports the failing step and the real error when the deep probe cannot write", async () => {
    emulator.failNext({ status: 403, code: "forbidden", message: "Access denied" });
    const health = await storage.deepHealthCheck();

    expect(health.reachable).toBe(false);
    expect(health.deepCheck?.ok).toBe(false);
    expect(health.deepCheck?.steps[0]?.step).toBe("put");
    expect(health.deepCheck?.steps[0]?.ok).toBe(false);
    expect(health.error).toContain("Access denied");
    expect(health.errorCode).toBe("BLOB_ACCESS_ERROR");
  });
});
