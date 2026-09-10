import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const verifyApiCredential = vi.fn();
const verifyApiSignature = vi.fn();
const verifyApiKey = vi.fn();
vi.mock("@/lib/security/api-keys", () => ({ verifyApiCredential, verifyApiSignature, verifyApiKey }));

const getSettings = vi.fn();
const getStorageStats = vi.fn();
const createBridgeFile = vi.fn();
const serializeFile = vi.fn();
const recordUploadLog = vi.fn();
const recordApiRequestSafe = vi.fn();
const writeAuditLogSafely = vi.fn();
const auditActorFrom = vi.fn((actor: { uid: string }) => ({ uid: actor.uid, email: null, type: "integration" }));
const defaultRetention = vi.fn();
const getStorageService = vi.fn();

vi.mock("@/lib/firestore/settings", () => ({ getSettings }));
vi.mock("@/lib/firestore/stats", () => ({ getStorageStats }));
vi.mock("@/lib/firestore/files", () => ({ createBridgeFile, serializeFile }));
vi.mock("@/lib/firestore/api-metrics", () => ({ recordUploadLog, recordApiRequestSafe }));
vi.mock("@/lib/firestore/audit", () => ({ writeAuditLogSafely, auditActorFrom }));
vi.mock("@/lib/retention", () => ({ defaultRetention }));
vi.mock("@/lib/storage/index", () => ({ getStorageService }));

const route = await import("@/app/api/v1/storage/upload/route");

const BOUNDARY = "----BridgeTestBoundary1234";
const PDF_CONTENT = "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF";
const KEY_ID = "am_store_live_kx8pQ2vN4rT7wZ9m";
const KEY_SECRET = "am_sec_live_xY9zW8vU7tS6rQ5pON4mLK3jI2hG1fE0dCbA9vN8mU7";

function filePart(filename: string, content: string, contentType = "application/pdf"): string {
  return (
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n${content}\r\n`
  );
}

function textPart(name: string, value: string): string {
  return `Content-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
}

function multipartBody(parts: string[]): string {
  return parts.map((part) => `--${BOUNDARY}\r\n${part}`).join("") + `--${BOUNDARY}--\r\n`;
}

let ipCounter = 0;
function uploadRequest(body: string, headers: Record<string, string> = {}): Request {
  ipCounter += 1;
  return new Request("https://gateway.test/api/v1/storage/upload", {
    method: "POST",
    headers: {
      "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      "x-forwarded-for": `10.9.0.${ipCounter}`,
      ...headers,
    },
    body,
  });
}

const dualHeaders = () => ({ "X-AM-Storage-Key-Id": KEY_ID, "X-AM-Storage-Key-Secret": KEY_SECRET });

const SETTINGS = {
  maxPdfSizeBytes: 50 * 1024 * 1024,
  storageLimitBytes: 10 * 1024 * 1024 * 1024,
  signedUrlExpirySeconds: 600,
};
const STATS = { totalStorageBytes: 0, pendingUploadBytes: 0 };

describe("POST /api/v1/storage/upload — embedded bridge (single Vercel deployment)", () => {
  const storage = {
    upload: vi.fn(),
    getMetadata: vi.fn(),
    getSignedUrl: vi.fn(),
    delete: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AM_STORAGE_KEYS;
    getSettings.mockResolvedValue(SETTINGS);
    getStorageStats.mockResolvedValue(STATS);
    defaultRetention.mockReturnValue({ autoDeleteEnabled: false, retentionType: "6_months", customDeleteAt: null });
    serializeFile.mockImplementation((file: { id: string; originalName: string; size: number }) => ({
      id: file.id,
      originalName: file.originalName,
      size: file.size,
      status: "active",
    }));
    createBridgeFile.mockImplementation(async (input: Record<string, unknown>) => ({ id: "file-1", ...input }));
    getStorageService.mockReturnValue(storage);
    storage.getSignedUrl.mockResolvedValue("https://r2.example/signed?sig=abc");
  });

  afterEach(() => {
    delete process.env.AM_STORAGE_KEYS;
  });

  it("rejects requests without any credential and logs the rejected attempt", async () => {
    const response = await route.POST(uploadRequest(multipartBody([filePart("a.pdf", PDF_CONTENT)])));

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("INVALID_API_KEY");
    expect(recordUploadLog).toHaveBeenCalledWith(expect.objectContaining({
      keyId: "rejected",
      filename: "unknown",
      status: "failed",
      failureCode: "INVALID_API_KEY",
    }));
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it("rejects revoked/unknown credentials without touching storage", async () => {
    verifyApiCredential.mockResolvedValue(null);

    const response = await route.POST(uploadRequest(multipartBody([filePart("a.pdf", PDF_CONTENT)]), dualHeaders()));

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("INVALID_API_KEY");
    expect(verifyApiCredential).toHaveBeenCalledWith(KEY_ID, KEY_SECRET);
    expect(storage.upload).not.toHaveBeenCalled();
    expect(recordUploadLog).toHaveBeenCalledWith(expect.objectContaining({ keyId: KEY_ID, status: "failed" }));
  });

  it("requires multipart/form-data", async () => {
    verifyApiCredential.mockResolvedValue("rec-1");
    const request = new Request("https://gateway.test/api/v1/storage/upload", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "10.9.9.1", ...dualHeaders() },
      body: JSON.stringify({ file: "nope" }),
    });

    const response = await route.POST(request);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 422 when the 'file' field is missing", async () => {
    verifyApiCredential.mockResolvedValue("rec-1");

    const response = await route.POST(uploadRequest(multipartBody([textPart("title", "No file")]), dualHeaders()));

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain("'file'");
  });

  it("rejects unsupported extensions", async () => {
    verifyApiCredential.mockResolvedValue("rec-1");

    const response = await route.POST(
      uploadRequest(multipartBody([filePart("run.exe", "MZ-binary", "application/octet-stream")]), dualHeaders()),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("INVALID_FILE_TYPE");
    expect(recordUploadLog).toHaveBeenCalledWith(expect.objectContaining({ failureCode: "INVALID_FILE_TYPE" }));
  });

  it("rejects documents larger than the configured cap", async () => {
    verifyApiCredential.mockResolvedValue("rec-1");
    getSettings.mockResolvedValue({ ...SETTINGS, maxPdfSizeBytes: 16 });

    const response = await route.POST(
      uploadRequest(multipartBody([filePart("big.pdf", PDF_CONTENT)]), dualHeaders()),
    );

    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe("FILE_TOO_LARGE");
  });

  it("rejects documents with invalid magic bytes", async () => {
    verifyApiCredential.mockResolvedValue("rec-1");

    const response = await route.POST(
      uploadRequest(multipartBody([filePart("fake.pdf", "this is plain text, not a pdf")]), dualHeaders()),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("INVALID_DOCUMENT");
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it("stores a valid dual-token upload in R2, registers it, and returns a signed URL", async () => {
    verifyApiCredential.mockResolvedValue("rec-1");
    storage.getMetadata.mockResolvedValue({ contentLength: PDF_CONTENT.length, contentType: "application/pdf" });

    const response = await route.POST(
      uploadRequest(multipartBody([filePart("annual-report.pdf", PDF_CONTENT), textPart("title", "Annual Report 2026")]), dualHeaders()),
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.data.filename).toBe("annual-report.pdf");
    expect(body.data.size).toBe(PDF_CONTENT.length);
    expect(body.data.url).toBe("https://r2.example/signed?sig=abc");
    expect(body.data.expiresAt).toBeTruthy();
    expect(body.data.file).toMatchObject({ id: "file-1", status: "active" });
    expect(body.requestId).toBeTruthy();

    expect(storage.upload).toHaveBeenCalledTimes(1);
    const uploadInput = storage.upload.mock.calls[0]![0] as { key: string; contentType: string; contentLength: number };
    expect(uploadInput.key).toMatch(/^documents\/\d{4}\/\d{2}\/[A-Za-z0-9-]+\.pdf$/);
    expect(uploadInput.contentType).toBe("application/pdf");
    expect(uploadInput.contentLength).toBe(PDF_CONTENT.length);

    expect(createBridgeFile).toHaveBeenCalledWith(expect.objectContaining({
      originalName: "annual-report.pdf",
      title: "Annual Report 2026",
      mimeType: "application/pdf",
      extension: "pdf",
      size: PDF_CONTENT.length,
      uploadedBy: `bridge:${KEY_ID}`,
    }));
    expect(writeAuditLogSafely).toHaveBeenCalledWith(expect.objectContaining({ action: "BRIDGE_UPLOAD", fileId: "file-1" }));
    expect(recordUploadLog).toHaveBeenCalledWith(expect.objectContaining({
      keyId: KEY_ID,
      filename: "annual-report.pdf",
      sizeBytes: PDF_CONTENT.length,
      status: "success",
      failureCode: null,
    }));
  });

  it("verifies HMAC signed requests over the exact raw body bytes", async () => {
    verifyApiSignature.mockResolvedValue("rec-2");
    storage.getMetadata.mockResolvedValue({ contentLength: PDF_CONTENT.length, contentType: "application/pdf" });
    const raw = multipartBody([filePart("signed.pdf", PDF_CONTENT)]);
    const bodyHash = createHash("sha256").update(Buffer.from(raw, "utf8")).digest("hex");
    const timestamp = Date.now();
    const signature = createHmac("sha256", KEY_SECRET).update(`${timestamp}:${bodyHash}`).digest("hex");

    const response = await route.POST(uploadRequest(raw, {
      "X-AM-Storage-Key-Id": KEY_ID,
      "X-AM-Storage-Timestamp": String(timestamp),
      "X-AM-Storage-Signature": signature,
    }));

    expect(response.status).toBe(201);
    expect(verifyApiSignature).toHaveBeenCalledWith({ keyId: KEY_ID, timestamp, signature, bodyHash });
    expect((await response.json()).data.filename).toBe("signed.pdf");
  });

  it("still accepts legacy single keys", async () => {
    verifyApiKey.mockResolvedValue("legacy-rec");
    storage.getMetadata.mockResolvedValue({ contentLength: PDF_CONTENT.length, contentType: "application/pdf" });
    const legacyKey = "am_store_live_legacy_value_for_tests";

    const response = await route.POST(
      uploadRequest(multipartBody([filePart("legacy.pdf", PDF_CONTENT)]), { "X-AM-Storage-Key": legacyKey }),
    );

    expect(response.status).toBe(201);
    expect(verifyApiKey).toHaveBeenCalledWith(legacyKey);
  });

  it("accepts static keys without a registry round-trip", async () => {
    process.env.AM_STORAGE_KEYS = "static-offline-key-1, static-offline-key-2";
    storage.getMetadata.mockResolvedValue({ contentLength: PDF_CONTENT.length, contentType: "application/pdf" });

    const response = await route.POST(
      uploadRequest(multipartBody([filePart("static.pdf", PDF_CONTENT)]), { "X-AM-Storage-Key": "static-offline-key-2" }),
    );

    expect(response.status).toBe(201);
    expect(verifyApiKey).not.toHaveBeenCalled();
    expect(verifyApiCredential).not.toHaveBeenCalled();
    expect(recordApiRequestSafe).toHaveBeenCalledWith("static");
  });

  it("maps an R2 outage to R2_UPLOAD_FAILED and removes the partial object", async () => {
    verifyApiCredential.mockResolvedValue("rec-1");
    storage.upload.mockRejectedValue(new Error("socket hang up"));

    const response = await route.POST(
      uploadRequest(multipartBody([filePart("doomed.pdf", PDF_CONTENT)]), dualHeaders()),
    );

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error.code).toBe("R2_UPLOAD_FAILED");
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(createBridgeFile).not.toHaveBeenCalled();
    expect(recordUploadLog).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", failureCode: "R2_UPLOAD_FAILED" }));
  });

  it("answers GET with 405 JSON (never an HTML page)", async () => {
    const response = await route.GET(new Request("https://gateway.test/api/v1/storage/upload"));

    expect(response.status).toBe(405);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("METHOD_NOT_ALLOWED");
  });

  it("answers OPTIONS preflights with the bridge CORS policy", async () => {
    const response = await route.OPTIONS(new Request("https://gateway.test/api/v1/storage/upload", {
      method: "OPTIONS",
      headers: { origin: "https://gramunnayan.com" },
    }));

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://gramunnayan.com");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(response.headers.get("access-control-allow-headers")).toContain("X-AM-Storage-Key-Id");
  });
});
