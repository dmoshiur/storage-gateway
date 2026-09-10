import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const requireAdminRequest = vi.fn();
vi.mock("@/lib/security/request-auth", () => ({ requireAdminRequest }));

vi.mock("@/lib/security/rate-limit", () => ({ enforceRateLimit: vi.fn() }));

const getBlobStoreConfig = vi.fn();
vi.mock("@/lib/env", () => ({ getBlobStoreConfig }));

const issueSignedToken = vi.fn();
const presignUrl = vi.fn();
vi.mock("@vercel/blob", () => ({ issueSignedToken, presignUrl }));

const handleUploadPresigned = vi.fn();
vi.mock("@vercel/blob/client", () => ({ handleUploadPresigned }));

const TOKEN_PAYLOAD = {
  delegationToken: "payload.signature",
  signature: "deadbeef",
  params: { "vercel-blob-valid-until": "123", "vercel-blob-allow-overwrite": "1" },
};

const OIDC_CONFIG = {
  token: null,
  storeId: "store_abc123",
  oidcToken: "oidc-token-value",
  webhookPublicKey: "-----BEGIN PUBLIC KEY-----abc-----END PUBLIC KEY-----",
};

const FALLBACK_CONFIG = {
  token: "vercel_blob_rw_store123_secret",
  storeId: "store123",
  oidcToken: null,
  webhookPublicKey: null,
};

const ISSUED_TOKEN = { delegationToken: "del", clientSigningToken: "cst", validUntil: 1 };

function tokenEventRequest(pathname = "pdfs/2026/09/uuid.pdf"): Request {
  return new Request("https://gateway.example.org/api/blob/upload", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://gateway.example.org" },
    body: JSON.stringify({
      type: "blob.generate-presigned-url",
      payload: { pathname, clientPayload: null, multipart: false },
    }),
  });
}

function completedEventRequest(): Request {
  return new Request("https://gateway.example.org/api/blob/upload", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "blob.upload-completed",
      payload: { blob: { pathname: "pdfs/2026/09/uuid.pdf", url: "https://x" }, tokenPayload: null },
    }),
  });
}

async function readError(response: Response): Promise<{ status: number; code: string }> {
  const body = (await response.json()) as { error?: { code?: string } };
  return { status: response.status, code: body.error?.code ?? "" };
}

describe("POST /api/blob/upload — OIDC presigned token endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Shrink the route's anti-hang guards so timeout tests run in milliseconds.
    process.env.BLOB_UPLOAD_SIGNING_TIMEOUT_MS = "25";
    process.env.BLOB_UPLOAD_ROUTE_TIMEOUT_MS = "250";
    requireAdminRequest.mockResolvedValue({ uid: "admin-1", email: "a@ngo.example", role: "admin", type: "admin" });
    issueSignedToken.mockResolvedValue(ISSUED_TOKEN);
  });

  afterEach(async () => {
    delete process.env.BLOB_UPLOAD_SIGNING_TIMEOUT_MS;
    delete process.env.BLOB_UPLOAD_ROUTE_TIMEOUT_MS;
    vi.resetModules();
  });

  it("authenticates and signs via handleUploadPresigned when the webhook key is configured", async () => {
    getBlobStoreConfig.mockReturnValue(OIDC_CONFIG);
    handleUploadPresigned.mockImplementation(async ({ getSignedToken }) => {
      const { token } = await getSignedToken("pdfs/2026/09/uuid.pdf", null, false);
      expect(token).toEqual(ISSUED_TOKEN);
      return { type: "blob.generate-presigned-url", presignedUrlPayload: TOKEN_PAYLOAD };
    });

    const { POST } = await import("@/app/api/blob/upload/route");
    const response = await POST(tokenEventRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      type: "blob.generate-presigned-url",
      presignedUrlPayload: TOKEN_PAYLOAD,
    });
    expect(requireAdminRequest).toHaveBeenCalledTimes(1);
    expect(issueSignedToken).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: "pdfs/2026/09/uuid.pdf",
        operations: ["put"],
        storeId: "store_abc123",
        oidcToken: "oidc-token-value",
        abortSignal: expect.any(AbortSignal),
      }),
    );
  });

  it("falls back to presignUrl signing (no webhook key) and extracts the client payload", async () => {
    getBlobStoreConfig.mockReturnValue(FALLBACK_CONFIG);
    presignUrl.mockResolvedValue({
      presignedUrl:
        "https://vercel.com/api/blob/?pathname=pdfs%2F2026%2F09%2Fuuid.pdf" +
        "&vercel-blob-valid-until=123&vercel-blob-allow-overwrite=1" +
        "&vercel-blob-delegation=payload.signature&vercel-blob-signature=deadbeef",
    });

    const { POST } = await import("@/app/api/blob/upload/route");
    const response = await POST(tokenEventRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      type: "blob.generate-presigned-url",
      presignedUrlPayload: TOKEN_PAYLOAD,
    });
    expect(issueSignedToken).toHaveBeenCalledWith(expect.objectContaining({ token: FALLBACK_CONFIG.token }));
    expect(presignUrl).toHaveBeenCalledWith(
      ISSUED_TOKEN,
      expect.objectContaining({ operation: "put", access: "private", pathname: "pdfs/2026/09/uuid.pdf" }),
    );
    expect(handleUploadPresigned).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated callers before any signing I/O", async () => {
    getBlobStoreConfig.mockReturnValue(OIDC_CONFIG);
    const { ApiError } = await import("@/lib/api/errors");
    requireAdminRequest.mockRejectedValue(new ApiError(401, "UNAUTHENTICATED", "Please sign in to continue."));

    const { POST } = await import("@/app/api/blob/upload/route");
    const response = await POST(tokenEventRequest());

    expect(response.status).toBe(401);
    expect(handleUploadPresigned).not.toHaveBeenCalled();
    expect(issueSignedToken).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON with 400", async () => {
    getBlobStoreConfig.mockReturnValue(OIDC_CONFIG);
    const { POST } = await import("@/app/api/blob/upload/route");
    const response = await POST(
      new Request("https://gateway.example.org/api/blob/upload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      }),
    );
    expect(response.status).toBe(400);
  });

  it("rejects unsupported event types with 400", async () => {
    getBlobStoreConfig.mockReturnValue(OIDC_CONFIG);
    const { POST } = await import("@/app/api/blob/upload/route");
    const response = await POST(
      new Request("https://gateway.example.org/api/blob/upload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "blob.unknown-event", payload: {} }),
      }),
    );
    expect(response.status).toBe(400);
  });

  it("rejects pathnames outside the allowed prefixes with 400", async () => {
    getBlobStoreConfig.mockReturnValue(OIDC_CONFIG);
    const { POST } = await import("@/app/api/blob/upload/route");
    const response = await POST(tokenEventRequest("etc/passwd"));
    expect(response.status).toBe(400);
    expect(issueSignedToken).not.toHaveBeenCalled();
  });

  it("fails fast (504 BLOB_SIGNING_TIMEOUT) when the signing call stalls and is aborted", async () => {
    getBlobStoreConfig.mockReturnValue(OIDC_CONFIG);
    // Mirror the real SDK/undici behaviour: the fetch rejects once aborted.
    issueSignedToken.mockImplementation(
      ({ abortSignal }) =>
        new Promise((_resolve, reject) => {
          abortSignal?.addEventListener("abort", () => reject(new Error("This operation was aborted")));
        }),
    );
    handleUploadPresigned.mockImplementation(async ({ getSignedToken }) => {
      await getSignedToken("pdfs/2026/09/uuid.pdf", null, false);
      throw new Error("unreachable");
    });

    const { POST } = await import("@/app/api/blob/upload/route");
    const startedAt = Date.now();
    const response = await POST(tokenEventRequest());

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(await readError(response)).toEqual({ status: 504, code: "BLOB_SIGNING_TIMEOUT" });
  });

  it("fails fast (504 UPLOAD_TOKEN_TIMEOUT) when the whole handler wedges", async () => {
    getBlobStoreConfig.mockReturnValue(OIDC_CONFIG);
    handleUploadPresigned.mockImplementation(() => new Promise(() => undefined)); // never settles

    const { POST } = await import("@/app/api/blob/upload/route");
    const startedAt = Date.now();
    const response = await POST(tokenEventRequest());

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(await readError(response)).toEqual({ status: 504, code: "UPLOAD_TOKEN_TIMEOUT" });
  });

  it("returns 501 for webhook completion callbacks when no webhook key is configured", async () => {
    getBlobStoreConfig.mockReturnValue(FALLBACK_CONFIG);
    const { POST } = await import("@/app/api/blob/upload/route");
    const response = await POST(completedEventRequest());
    expect(response.status).toBe(501);
    expect(handleUploadPresigned).not.toHaveBeenCalled();
  });
});
