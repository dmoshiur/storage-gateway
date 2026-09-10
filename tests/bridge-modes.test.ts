import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const verifyApiKey = vi.fn();
const verifyApiCredential = vi.fn();
const verifyApiSignature = vi.fn();
vi.mock("@/lib/security/api-keys", () => ({ verifyApiKey, verifyApiCredential, verifyApiSignature }));

const requireIntegrationKey = vi.fn();
vi.mock("@/lib/security/request-auth", () => ({ requireIntegrationKey }));
vi.mock("@/lib/env", () => ({
  getRequiredSecret: () => "integration-secret-that-is-long-enough",
}));
vi.mock("@/lib/auth/session", () => ({
  SESSION_COOKIE_NAME: "ngo_gateway_session",
  verifySessionCookie: vi.fn(),
}));

const recordUploadLog = vi.fn();
vi.mock("@/lib/firestore/api-metrics", () => ({ recordUploadLog }));

const verifyKeyRoute = await import("@/app/api/internal/bridge/verify-key/route");
const uploadLogRoute = await import("@/app/api/internal/bridge/upload-logs/route");

function internalRequest(path: string, body: unknown): Request {
  return new Request(`https://gateway.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Storage-Gateway-Key": "integration-secret-that-is-long-enough",
    },
    body: JSON.stringify(body),
  });
}

describe("internal bridge verify-key (dual-token + HMAC modes)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireIntegrationKey.mockResolvedValue({ uid: "website-integration", email: null, role: "viewer", type: "integration" });
  });

  it("verifies dual-token credentials against the digest registry", async () => {
    verifyApiCredential.mockResolvedValue("key-record-9");
    const response = await verifyKeyRoute.POST(internalRequest("/api/internal/bridge/verify-key", {
      mode: "dual_token",
      keyId: "am_store_live_kx8pQ2vN4rT7wZ9m",
      secret: "am_sec_live_xY9zW8vU7tS6rQ5pON4mLK3jI2hG1fE0dCbA9vN8mU7",
    }));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ valid: true, keyId: "key-record-9" });
    expect(verifyApiCredential).toHaveBeenCalledWith("am_store_live_kx8pQ2vN4rT7wZ9m", "am_sec_live_xY9zW8vU7tS6rQ5pON4mLK3jI2hG1fE0dCbA9vN8mU7");
    expect(verifyApiKey).not.toHaveBeenCalled();
  });

  it("verifies HMAC signed requests with timestamp and body hash", async () => {
    verifyApiSignature.mockResolvedValue("key-record-10");
    const response = await verifyKeyRoute.POST(internalRequest("/api/internal/bridge/verify-key", {
      mode: "signature",
      keyId: "am_store_live_kx8pQ2vN4rT7wZ9m",
      timestamp: 1788888888,
      signature: "a".repeat(64),
      bodyHash: "b".repeat(64),
    }));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ valid: true, keyId: "key-record-10" });
    expect(verifyApiSignature).toHaveBeenCalledWith({
      keyId: "am_store_live_kx8pQ2vN4rT7wZ9m",
      timestamp: 1788888888,
      signature: "a".repeat(64),
      bodyHash: "b".repeat(64),
    });
  });

  it("rejects malformed dual-token payloads before any registry lookup", async () => {
    const response = await verifyKeyRoute.POST(internalRequest("/api/internal/bridge/verify-key", {
      mode: "dual_token",
      keyId: "am_store_live_kx8pQ2vN4rT7wZ9m",
    }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
    expect(verifyApiCredential).not.toHaveBeenCalled();
  });

  it("rejects non-hex signatures and unknown modes", async () => {
    const badSignature = await verifyKeyRoute.POST(internalRequest("/api/internal/bridge/verify-key", {
      mode: "signature",
      keyId: "am_store_live_kx8pQ2vN4rT7wZ9m",
      timestamp: 1788888888,
      signature: "not-a-hex-signature",
      bodyHash: "b".repeat(64),
    }));
    expect(badSignature.status).toBe(400);

    const badMode = await verifyKeyRoute.POST(internalRequest("/api/internal/bridge/verify-key", {
      mode: "quantum",
      keyId: "am_store_live_kx8pQ2vN4rT7wZ9m",
    }));
    expect(badMode.status).toBe(400);
  });

  it("still accepts the legacy single-key payload (backward compatibility)", async () => {
    verifyApiKey.mockResolvedValue(null);
    const response = await verifyKeyRoute.POST(internalRequest("/api/internal/bridge/verify-key", {
      key: "am_store_live_legacy_value_here",
    }));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ valid: false, keyId: null });
    expect(verifyApiKey).toHaveBeenCalledWith("am_store_live_legacy_value_here");
  });
});

describe("internal bridge upload-logs (dashboard API activity feed)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireIntegrationKey.mockResolvedValue({ uid: "website-integration", email: null, role: "viewer", type: "integration" });
  });

  it("records a successful upload attempt", async () => {
    const response = await uploadLogRoute.POST(internalRequest("/api/internal/bridge/upload-logs", {
      keyId: "am_store_live_kx8pQ2vN4rT7wZ9m",
      filename: "annual-report.pdf",
      sizeBytes: 42_000,
      status: "success",
      failureCode: null,
      requestId: "req-123",
      timestamp: "2026-09-09T12:00:00.000Z",
    }));
    expect(response.status).toBe(200);
    expect(recordUploadLog).toHaveBeenCalledWith(expect.objectContaining({
      filename: "annual-report.pdf",
      status: "success",
      sizeBytes: 42_000,
    }));
  });

  it("records a failed upload attempt with its failure code", async () => {
    const response = await uploadLogRoute.POST(internalRequest("/api/internal/bridge/upload-logs", {
      keyId: "rejected",
      filename: "invoice.pdf",
      sizeBytes: 0,
      status: "failed",
      failureCode: "BLOB_UPLOAD_FAILED",
      requestId: "req-124",
      timestamp: "2026-09-09T12:01:00.000Z",
    }));
    expect(response.status).toBe(200);
    expect(recordUploadLog).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      failureCode: "BLOB_UPLOAD_FAILED",
    }));
  });

  it("rejects invalid log entries (bad status, non-PDF size, missing timestamp)", async () => {
    const badStatus = await uploadLogRoute.POST(internalRequest("/api/internal/bridge/upload-logs", {
      keyId: "k", filename: "a.pdf", sizeBytes: 1, status: "meh", requestId: "r", timestamp: "2026-09-09T12:00:00Z",
    }));
    expect(badStatus.status).toBe(400);

    const badSize = await uploadLogRoute.POST(internalRequest("/api/internal/bridge/upload-logs", {
      keyId: "k", filename: "a.pdf", sizeBytes: -5, status: "success", requestId: "r", timestamp: "2026-09-09T12:00:00Z",
    }));
    expect(badSize.status).toBe(400);

    const missing = await uploadLogRoute.POST(internalRequest("/api/internal/bridge/upload-logs", {
      keyId: "k", filename: "a.pdf", sizeBytes: 1, status: "success", requestId: "r",
    }));
    expect(missing.status).toBe(400);
    expect(recordUploadLog).not.toHaveBeenCalled();
  });
});
