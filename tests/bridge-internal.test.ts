import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const verifyApiKey = vi.fn();
vi.mock("@/lib/security/api-keys", () => ({ verifyApiKey }));

vi.mock("@/lib/env", () => ({
  getRequiredSecret: () => "integration-secret-that-is-long-enough",
}));

vi.mock("@/lib/auth/session", () => ({
  SESSION_COOKIE_NAME: "ngo_gateway_session",
  verifySessionCookie: vi.fn(),
}));

const getSettings = vi.fn();
const getStorageStats = vi.fn();
const createBridgeFile = vi.fn();
const serializeFile = vi.fn();
const writeAuditLogSafely = vi.fn();
const auditActorFrom = vi.fn((actor: { uid: string }) => ({ uid: actor.uid, email: null, type: "integration" }));
const defaultRetention = vi.fn();

vi.mock("@/lib/firestore/settings", () => ({ getSettings }));
vi.mock("@/lib/firestore/stats", () => ({ getStorageStats }));
vi.mock("@/lib/firestore/files", () => ({ createBridgeFile, serializeFile }));
vi.mock("@/lib/firestore/audit", () => ({ writeAuditLogSafely, auditActorFrom }));
vi.mock("@/lib/retention", () => ({ defaultRetention }));

const verifyKeyRoute = await import("@/app/api/internal/bridge/verify-key/route");
const registerRoute = await import("@/app/api/internal/bridge/files/route");

function internalRequest(url: string, init: RequestInit = {}): Request {
  return new Request(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      "X-Storage-Gateway-Key": "integration-secret-that-is-long-enough",
      ...init.headers,
    },
  });
}

describe("internal bridge key verification (dashboard registry)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects requests without the server-to-server integration key", async () => {
    const response = await verifyKeyRoute.POST(new Request("https://gateway.test/api/internal/bridge/verify-key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "am_store_live_anything" }),
    }));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects a mismatched integration key", async () => {
    const request = internalRequest("https://gateway.test/api/internal/bridge/verify-key", {
      method: "POST",
      body: JSON.stringify({ key: "am_store_live_anything" }),
    });
    request.headers.set("X-Storage-Gateway-Key", "a-completely-wrong-key");
    const response = await verifyKeyRoute.POST(request);
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("INVALID_INTEGRATION_KEY");
  });

  it("reports active keys as valid without exposing the raw key", async () => {
    verifyApiKey.mockResolvedValue("key-record-123");
    const response = await verifyKeyRoute.POST(internalRequest("https://gateway.test/api/internal/bridge/verify-key", {
      method: "POST",
      body: JSON.stringify({ key: "am_store_live_abc123" }),
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ valid: true, keyId: "key-record-123" });
    expect(verifyApiKey).toHaveBeenCalledWith("am_store_live_abc123");
  });

  it("treats revoked or unknown keys as invalid (still 200 so outages stay distinguishable)", async () => {
    verifyApiKey.mockResolvedValue(null);
    const response = await verifyKeyRoute.POST(internalRequest("https://gateway.test/api/internal/bridge/verify-key", {
      method: "POST",
      body: JSON.stringify({ key: "am_store_live_revoked" }),
    }));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ valid: false, keyId: null });
  });
});

describe("internal bridge file registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSettings.mockResolvedValue({
      maxPdfSizeBytes: 50 * 1024 * 1024,
      storageLimitBytes: 10 * 1024 * 1024 * 1024,
      defaultAutoDelete: false,
      defaultRetentionType: "6_months",
    });
    getStorageStats.mockResolvedValue({ totalStorageBytes: 0, pendingUploadBytes: 0 });
    defaultRetention.mockReturnValue({ autoDeleteEnabled: false, retentionType: "6_months", customDeleteAt: null });
    createBridgeFile.mockImplementation(async (input: Record<string, unknown>) => ({
      id: "bridge-file-1",
      storagePath: input.storagePath,
      originalName: input.originalName,
      title: input.title,
      size: input.size,
      status: "active",
    }));
    serializeFile.mockImplementation((document: Record<string, unknown>) => document);
  });

  it("registers a bridge-verified PDF as an active document", async () => {
    const response = await registerRoute.POST(internalRequest("https://gateway.test/api/internal/bridge/files", {
      method: "POST",
      body: JSON.stringify({
        storagePath: "pdfs/2026/09/6fd9b9a4-07bd-4d2b-b0b9-6f0a0f0f0f0f.pdf",
        originalName: "annual-report.pdf",
        title: "Annual Report 2026",
        description: "",
        category: "Reports",
        tags: ["reports", "annual"],
        size: 42_000,
      }),
    }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.data.file).toMatchObject({ id: "bridge-file-1", originalName: "annual-report.pdf", status: "active" });
    expect(createBridgeFile).toHaveBeenCalledWith(expect.objectContaining({ size: 42_000, uploadedBy: "website-integration" }));
    expect(writeAuditLogSafely).toHaveBeenCalledWith(expect.objectContaining({ action: "BRIDGE_UPLOAD" }));
  });

  it("registers non-PDF office and text documents through the same bridge", async () => {
    const response = await registerRoute.POST(internalRequest("https://gateway.test/api/internal/bridge/files", {
      method: "POST",
      body: JSON.stringify({
        storagePath: "documents/2026/09/6fd9b9a4-07bd-4d2b-b0b9-6f0a0f0f0f0f.txt",
        originalName: "meeting-notes.txt",
        title: "Meeting notes",
        size: 64,
        extension: "txt",
        mimeType: "text/plain",
      }),
    }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.data.file).toMatchObject({ originalName: "meeting-notes.txt", status: "active" });
    expect(createBridgeFile).toHaveBeenCalledWith(expect.objectContaining({ mimeType: "text/plain", extension: "txt" }));
  });

  it("rejects unsupported names and oversized files before any write", async () => {
    const badName = await registerRoute.POST(internalRequest("https://gateway.test/api/internal/bridge/files", {
      method: "POST",
      body: JSON.stringify({
        storagePath: "pdfs/2026/09/6fd9b9a4-07bd-4d2b-b0b9-6f0a0f0f0f0f.pdf",
        originalName: "notes.exe",
        size: 100,
      }),
    }));
    expect(badName.status).toBe(400);
    expect((await badName.json()).error.code).toBe("INVALID_FILE_TYPE");

    const tooLarge = await registerRoute.POST(internalRequest("https://gateway.test/api/internal/bridge/files", {
      method: "POST",
      body: JSON.stringify({
        storagePath: "pdfs/2026/09/6fd9b9a4-07bd-4d2b-b0b9-6f0a0f0f0f0f.pdf",
        originalName: "huge.pdf",
        size: 500 * 1024 * 1024,
      }),
    }));
    expect(tooLarge.status).toBe(413);
    expect((await tooLarge.json()).error.code).toBe("FILE_TOO_LARGE");
    expect(createBridgeFile).not.toHaveBeenCalled();
  });

  it("refuses registration when the configured storage limit would be exceeded", async () => {
    getSettings.mockResolvedValue({
      maxPdfSizeBytes: 1024 * 1024 * 1024,
      storageLimitBytes: 10 * 1024 * 1024 * 1024,
      defaultAutoDelete: false,
      defaultRetentionType: "6_months",
    });
    getStorageStats.mockResolvedValue({ totalStorageBytes: 9.5 * 1024 * 1024 * 1024, pendingUploadBytes: 0 });
    const response = await registerRoute.POST(internalRequest("https://gateway.test/api/internal/bridge/files", {
      method: "POST",
      body: JSON.stringify({
        storagePath: "pdfs/2026/09/6fd9b9a4-07bd-4d2b-b0b9-6f0a0f0f0f0f.pdf",
        originalName: "big.pdf",
        size: 900 * 1024 * 1024,
      }),
    }));
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("STORAGE_LIMIT_EXCEEDED");
    expect(createBridgeFile).not.toHaveBeenCalled();
  });
});
