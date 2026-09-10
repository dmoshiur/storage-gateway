import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const verifyApiCredential = vi.fn();
const verifyApiSignature = vi.fn();
const verifyApiKey = vi.fn();
vi.mock("@/lib/security/api-keys", () => ({ verifyApiCredential, verifyApiSignature, verifyApiKey }));

const getSettings = vi.fn();
const getStorageStats = vi.fn();
const createUploadingFile = vi.fn();
const requireFileById = vi.fn();
const activateUpload = vi.fn();
const clearUploadKey = vi.fn();
const markUploadFailed = vi.fn();
const serializeFile = vi.fn();
const recordUploadLog = vi.fn();
const recordApiRequestSafe = vi.fn();
const writeAuditLogSafely = vi.fn();
const auditActorFrom = vi.fn((actor: { uid: string }) => ({ uid: actor.uid, email: null, type: "integration" }));
const defaultRetention = vi.fn();
const getStorageService = vi.fn();

vi.mock("@/lib/firestore/settings", () => ({ getSettings }));
vi.mock("@/lib/firestore/stats", () => ({ getStorageStats }));
vi.mock("@/lib/firestore/files", () => ({
  createUploadingFile,
  requireFileById,
  activateUpload,
  clearUploadKey,
  markUploadFailed,
  serializeFile,
}));
vi.mock("@/lib/firestore/api-metrics", () => ({ recordUploadLog, recordApiRequestSafe }));
vi.mock("@/lib/firestore/audit", () => ({ writeAuditLogSafely, auditActorFrom }));
vi.mock("@/lib/retention", () => ({ defaultRetention }));
vi.mock("@/lib/storage/index", () => ({ getStorageService }));

const initRoute = await import("@/app/api/v1/storage/upload/init/route");
const completeRoute = await import("@/app/api/v1/storage/upload/complete/route");
const { ApiError } = await import("@/lib/api/errors");

const KEY_ID = "am_store_live_kx8pQ2vN4rT7wZ9m";
const KEY_SECRET = "am_sec_live_xY9zW8vU7tS6rQ5pON4mLK3jI2hG1fE0dCbA9vN8mU7";
const PDF_CONTENT = "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF";

const SETTINGS = {
  maxPdfSizeBytes: 50 * 1024 * 1024,
  storageLimitBytes: 10 * 1024 * 1024 * 1024,
  signedUrlExpirySeconds: 600,
};
const STATS = { totalStorageBytes: 0, pendingUploadBytes: 0 };

let ipCounter = 100;
function jsonRequest(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  ipCounter += 1;
  return new Request(`https://gateway.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `10.9.1.${ipCounter}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const dualHeaders = () => ({ "X-AM-Storage-Key-Id": KEY_ID, "X-AM-Storage-Key-Secret": KEY_SECRET });

describe("POST /api/v1/storage/upload/init — presigned upload step 1", () => {
  const storage = { getSignedUploadUrl: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    getSettings.mockResolvedValue(SETTINGS);
    getStorageStats.mockResolvedValue(STATS);
    defaultRetention.mockReturnValue({ autoDeleteEnabled: false, retentionType: "6_months", customDeleteAt: null });
    getStorageService.mockReturnValue(storage);
    serializeFile.mockImplementation((file: { id: string }) => ({ id: file.id, status: "uploading" }));
    createUploadingFile.mockImplementation(async (input: Record<string, unknown>) => ({ id: "upload-1", ...input }));
    storage.getSignedUploadUrl.mockResolvedValue("https://blob.example/put?sig=upload");
  });

  it("rejects unauthenticated init requests", async () => {
    const response = await initRoute.POST(jsonRequest("/api/v1/storage/upload/init", { originalName: "a.pdf", size: 10 }));
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("INVALID_API_KEY");
    expect(createUploadingFile).not.toHaveBeenCalled();
  });

  it("rejects non-JSON and malformed payloads", async () => {
    verifyApiCredential.mockResolvedValue("rec-1");
    const badType = new Request("https://gateway.test/api/v1/storage/upload/init", {
      method: "POST",
      headers: { "content-type": "text/plain", "x-forwarded-for": "10.9.1.1", ...dualHeaders() },
      body: "hello",
    });
    expect((await (await initRoute.POST(badType)).json()).error.code).toBe("UNSUPPORTED_MEDIA_TYPE");

    const missing = await initRoute.POST(jsonRequest("/api/v1/storage/upload/init", { size: 10 }, dualHeaders()));
    expect(missing.status).toBe(400);
    expect((await missing.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects unsupported types and over-limit documents", async () => {
    verifyApiCredential.mockResolvedValue("rec-1");
    const exe = await initRoute.POST(
      jsonRequest("/api/v1/storage/upload/init", { originalName: "run.exe", size: 100 }, dualHeaders()),
    );
    expect(exe.status).toBe(400);
    expect((await exe.json()).error.code).toBe("INVALID_FILE_TYPE");

    getStorageStats.mockResolvedValue({ totalStorageBytes: SETTINGS.storageLimitBytes, pendingUploadBytes: 0 });
    const full = await initRoute.POST(
      jsonRequest("/api/v1/storage/upload/init", { originalName: "a.pdf", size: 100 }, dualHeaders()),
    );
    expect(full.status).toBe(409);
    expect((await full.json()).error.code).toBe("STORAGE_LIMIT_EXCEEDED");
  });

  it("mints a staging upload URL tied to the calling credential", async () => {
    verifyApiCredential.mockResolvedValue("rec-1");

    const response = await initRoute.POST(
      jsonRequest("/api/v1/storage/upload/init", {
        originalName: "annual-report.pdf",
        size: 1024,
        mimeType: "application/pdf",
        title: "Annual Report 2026",
        tags: ["annual", "report"],
      }, dualHeaders()),
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.data.uploadUrl).toBe("https://blob.example/put?sig=upload");
    expect(body.data.uploadHeaders).toEqual({ "Content-Type": "application/pdf" });
    expect(body.data.uploadMethod).toBe("PUT");
    expect(body.data.file).toMatchObject({ id: "upload-1", status: "uploading" });
    expect(body.data.directUploadRecommended).toBe(true);
    expect(body.data.expiresAt).toBeTruthy();

    expect(createUploadingFile).toHaveBeenCalledWith(expect.objectContaining({
      originalName: "annual-report.pdf",
      title: "Annual Report 2026",
      tags: ["annual", "report"],
      mimeType: "application/pdf",
      extension: "pdf",
      size: 1024,
      uploadedBy: `bridge:${KEY_ID}`,
    }));
    const created = createUploadingFile.mock.calls[0]![0] as { storagePath: string; uploadKey: string | null };
    expect(created.storagePath).toMatch(/^pdfs\/\d{4}\/\d{2}\/.+\.pdf$/);
    expect(created.uploadKey).toBeNull();
    expect(markUploadFailed).not.toHaveBeenCalled();
  });

  it("flags large declarations for the presigned flow", async () => {
    verifyApiCredential.mockResolvedValue("rec-1");

    const response = await initRoute.POST(
      jsonRequest("/api/v1/storage/upload/init", { originalName: "big.pdf", size: 40 * 1024 * 1024 }, dualHeaders()),
    );

    expect(response.status).toBe(201);
    expect((await response.json()).data.directUploadRecommended).toBe(false);
  });

  it("marks the reservation failed when URL signing fails", async () => {
    verifyApiCredential.mockResolvedValue("rec-1");
    storage.getSignedUploadUrl.mockRejectedValue(new Error("blob down"));

    const response = await initRoute.POST(
      jsonRequest("/api/v1/storage/upload/init", { originalName: "a.pdf", size: 100 }, dualHeaders()),
    );

    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe("STORAGE_UNAVAILABLE");
    expect(markUploadFailed).toHaveBeenCalledWith("upload-1", "UPLOAD_URL_GENERATION_FAILED");
  });
});

describe("POST /api/v1/storage/upload/complete — presigned upload step 3", () => {
  const storage = {
    getMetadata: vi.fn(),
    download: vi.fn(),
    copy: vi.fn(),
    delete: vi.fn(),
    getSignedUrl: vi.fn(),
  };

  const headBytes = () => new TextEncoder().encode(PDF_CONTENT);
  const tailBytes = () => new TextEncoder().encode(PDF_CONTENT);

  beforeEach(() => {
    vi.clearAllMocks();
    getSettings.mockResolvedValue(SETTINGS);
    getStorageStats.mockResolvedValue(STATS);
    getStorageService.mockReturnValue(storage);
    serializeFile.mockImplementation((file: { id: string; status: string }) => ({ id: file.id, status: file.status }));
    storage.getSignedUrl.mockResolvedValue("https://blob.example/signed?sig=done");
    verifyApiCredential.mockResolvedValue("rec-1");
  });

  function uploadingFile(overrides: Record<string, unknown> = {}) {
    return {
      id: "upload-1",
      storagePath: "pdfs/2026/09/final.pdf",
      uploadKey: null,
      originalName: "annual-report.pdf",
      title: "Annual Report",
      description: "",
      category: "",
      tags: [],
      mimeType: "application/pdf",
      extension: "pdf",
      size: PDF_CONTENT.length,
      status: "uploading",
      uploadedBy: `bridge:${KEY_ID}`,
      ...overrides,
    };
  }

  function validBlob() {
    storage.getMetadata.mockResolvedValue({
      contentLength: PDF_CONTENT.length,
      contentType: "application/pdf",
      etag: '"etag-1"',
      metadata: { "file-id": "upload-1" },
    });
    storage.download.mockResolvedValueOnce(headBytes()).mockResolvedValueOnce(tailBytes());
  }

  it("rejects unauthenticated completions", async () => {
    const response = await completeRoute.POST(jsonRequest("/api/v1/storage/upload/complete", { fileId: "upload-1" }));
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("INVALID_API_KEY");
  });

  it("rejects unknown files and malformed ids", async () => {
    const malformed = await completeRoute.POST(
      jsonRequest("/api/v1/storage/upload/complete", { fileId: "!!!" }, dualHeaders()),
    );
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error.code).toBe("VALIDATION_ERROR");

    requireFileById.mockRejectedValue(new ApiError(404, "FILE_NOT_FOUND", "missing"));
    const missing = await completeRoute.POST(
      jsonRequest("/api/v1/storage/upload/complete", { fileId: "upload-9" }, dualHeaders()),
    );
    expect(missing.status).toBe(404);
    expect(recordUploadLog).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", failureCode: "FILE_NOT_FOUND" }));
  });

  it("refuses to complete uploads started by a different credential", async () => {
    requireFileById.mockResolvedValue(uploadingFile({ uploadedBy: "bridge:am_store_live_somebody_else" }));

    const response = await completeRoute.POST(
      jsonRequest("/api/v1/storage/upload/complete", { fileId: "upload-1" }, dualHeaders()),
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("FORBIDDEN");
    expect(storage.copy).not.toHaveBeenCalled();
  });

  it("rejects completions for non-pending uploads", async () => {
    requireFileById.mockResolvedValue(uploadingFile({ status: "failed" }));

    const response = await completeRoute.POST(
      jsonRequest("/api/v1/storage/upload/complete", { fileId: "upload-1" }, dualHeaders()),
    );

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("UPLOAD_NOT_PENDING");
  });

  it("is idempotent for already-active uploads (mints a fresh URL)", async () => {
    requireFileById.mockResolvedValue(uploadingFile({ status: "active", uploadKey: null }));

    const response = await completeRoute.POST(
      jsonRequest("/api/v1/storage/upload/complete", { fileId: "upload-1" }, dualHeaders()),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.url).toBe("https://blob.example/signed?sig=done");
    expect(body.data.filename).toBe("annual-report.pdf");
    expect(storage.copy).not.toHaveBeenCalled();
    expect(recordUploadLog).toHaveBeenCalledWith(expect.objectContaining({ status: "success" }));
  });

  it("verifies, publishes, and registers the staged document", async () => {
    requireFileById.mockResolvedValue(uploadingFile());
    validBlob();
    activateUpload.mockImplementation(async (id: string) => ({ ...uploadingFile(), id, status: "active", uploadKey: null }));

    const response = await completeRoute.POST(
      jsonRequest("/api/v1/storage/upload/complete", { fileId: "upload-1" }, dualHeaders()),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.data.url).toBe("https://blob.example/signed?sig=done");
    expect(body.data.filename).toBe("annual-report.pdf");
    expect(body.data.size).toBe(PDF_CONTENT.length);
    expect(body.data.file).toMatchObject({ id: "upload-1", status: "active" });

    expect(storage.copy).not.toHaveBeenCalled();
    expect(activateUpload).toHaveBeenCalledWith("upload-1");
    expect(writeAuditLogSafely).toHaveBeenCalledWith(expect.objectContaining({ action: "BRIDGE_UPLOAD", fileId: "upload-1" }));
    expect(recordUploadLog).toHaveBeenCalledWith(expect.objectContaining({
      keyId: KEY_ID,
      filename: "annual-report.pdf",
      sizeBytes: PDF_CONTENT.length,
      status: "success",
      failureCode: null,
    }));
  });

  it("fails closed on invalid staged bytes and cleans up", async () => {
    requireFileById.mockResolvedValue(uploadingFile());
    storage.getMetadata.mockResolvedValue({
      contentLength: PDF_CONTENT.length,
      contentType: "application/pdf",
      etag: '"etag-1"',
      metadata: { "file-id": "upload-1" },
    });
    const junk = new TextEncoder().encode("not a pdf at all, just text");
    storage.download.mockResolvedValueOnce(junk).mockResolvedValueOnce(junk);

    const response = await completeRoute.POST(
      jsonRequest("/api/v1/storage/upload/complete", { fileId: "upload-1" }, dualHeaders()),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("INVALID_DOCUMENT");
    expect(storage.delete).toHaveBeenCalledWith("pdfs/2026/09/final.pdf");
    expect(markUploadFailed).toHaveBeenCalledWith("upload-1", "INVALID_DOCUMENT");
    expect(writeAuditLogSafely).toHaveBeenCalledWith(expect.objectContaining({ action: "UPLOAD_FAILED" }));
    expect(recordUploadLog).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", failureCode: "INVALID_DOCUMENT" }));
  });
});
