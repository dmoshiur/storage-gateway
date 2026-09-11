import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const requireReadActor = vi.fn();
vi.mock("@/lib/security/request-auth", () => ({ requireReadActor }));
vi.mock("@/lib/security/rate-limit", () => ({ enforceRateLimit: vi.fn() }));
vi.mock("@/lib/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn() }));

const storage = { downloadStream: vi.fn(), getSignedUrl: vi.fn() };
vi.mock("@/lib/storage", () => ({ getStorageService: () => storage }));

const state: { docs: Map<string, Record<string, unknown>> } = { docs: new Map() };

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    collection: () => ({
      doc: (id: string) => ({
        id,
        get: async () => {
          const data = state.docs.get(id);
          return { exists: Boolean(data), id, data: () => (data ? { ...data } : undefined) };
        },
        set: async () => undefined,
      }),
      add: async () => ({ id: "audit-1" }),
    }),
  }),
}));

const preview = await import("@/app/api/files/[id]/preview/route");
const download = await import("@/app/api/files/[id]/download/route");

const FILE_ID = "file-stream1";
const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");

function seedFile(overrides: Record<string, unknown> = {}): void {
  const now = new Date("2026-09-06T08:00:00.000Z");
  state.docs.set(FILE_ID, {
    storagePath: `pdfs/2026/09/${FILE_ID}.pdf`,
    blobUrl: "https://store.blob.vercel-storage.com/pdfs/2026/09/file-stream1.pdf",
    uploadKey: null,
    originalName: "annual report.pdf",
    title: "Annual report",
    description: "",
    category: "Reports",
    tags: [],
    mimeType: "application/pdf",
    extension: "pdf",
    size: PDF_BYTES.byteLength,
    contentHash: null,
    createdAt: now,
    updatedAt: now,
    uploadedBy: "admin-1",
    isFavorite: false,
    autoDeleteEnabled: false,
    retentionType: "never",
    customDeleteAt: null,
    deleteAt: null,
    status: "active",
    deletedAt: null,
    deletedBy: null,
    permanentDeleteAt: null,
    permanentlyDeletedAt: null,
    deletionStartedAt: null,
    deletionPreviousStatus: null,
    deletionReason: null,
    uploadExpiresAt: null,
    validatedAt: now,
    lastAccessedAt: null,
    lastDownloadedAt: null,
    failureCode: null,
    version: 1,
    ...overrides,
  });
}

function request(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://gateway.example.org${path}`, { headers: { cookie: "ngo_gateway_session=admin", ...headers } });
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe("authenticated server-side streaming of private PDFs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.docs.clear();
    seedFile();
    requireReadActor.mockResolvedValue({ uid: "admin-1", email: "a@ngo.example", role: "admin", type: "admin" });
    storage.downloadStream.mockResolvedValue({
      stream: streamOf(PDF_BYTES),
      contentLength: PDF_BYTES.byteLength,
      contentType: "application/pdf",
      statusCode: 200,
    });
    storage.getSignedUrl.mockResolvedValue("https://store.blob.vercel-storage.com/signed?short-lived=1");
  });

  it("streams preview bytes through the API route without exposing any Blob URL", async () => {
    const response = await preview.GET(request(`/api/files/${FILE_ID}/preview?stream=true`), {
      params: Promise.resolve({ id: FILE_ID }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toContain("inline");
    expect(response.headers.get("content-disposition")).toContain("annual report.pdf");
    expect(response.headers.get("content-length")).toBe(String(PDF_BYTES.byteLength));
    expect(response.headers.get("cache-control")).toContain("no-store");

    const body = new Uint8Array(await response.arrayBuffer());
    expect([...body]).toEqual([...PDF_BYTES]);

    const raw = new TextDecoder().decode(body);
    expect(raw).not.toContain("blob.vercel-storage.com");
    expect(storage.downloadStream).toHaveBeenCalledWith(`pdfs/2026/09/${FILE_ID}.pdf`, undefined);
    expect(storage.getSignedUrl).not.toHaveBeenCalled();
  });

  it("streams downloads as attachments", async () => {
    const response = await download.GET(request(`/api/files/${FILE_ID}/download?stream=true`), {
      params: Promise.resolve({ id: FILE_ID }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...PDF_BYTES]);
  });

  it("keeps requiring an authenticated session before any bytes are read", async () => {
    const { ApiError } = await import("@/lib/api/errors");
    requireReadActor.mockRejectedValue(new ApiError(401, "UNAUTHENTICATED", "Please sign in to continue."));
    const response = await preview.GET(request(`/api/files/${FILE_ID}/preview?stream=true`), {
      params: Promise.resolve({ id: FILE_ID }),
    });
    expect(response.status).toBe(401);
    expect(storage.downloadStream).not.toHaveBeenCalled();
  });

  it("never streams a document that is not active", async () => {
    seedFile({ status: "trash" });
    const response = await preview.GET(request(`/api/files/${FILE_ID}/preview?stream=true`), {
      params: Promise.resolve({ id: FILE_ID }),
    });
    expect(response.status).toBe(404);
    expect(storage.downloadStream).not.toHaveBeenCalled();
  });

  it("reports the real Blob failure when the store cannot serve the object", async () => {
    storage.downloadStream.mockRejectedValue(new Error("Vercel Blob returned 403 for this store"));
    const response = await preview.GET(request(`/api/files/${FILE_ID}/preview?stream=true`), {
      params: Promise.resolve({ id: FILE_ID }),
    });
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("FILE_STREAM_FAILED");
    expect(body.error.details.cause).toContain("Vercel Blob returned 403");
    expect(body.error.details.fileId).toBe(FILE_ID);
  });

  it("still serves short-lived signed links when streaming is not requested", async () => {
    const response = await preview.GET(request(`/api/files/${FILE_ID}/preview`), {
      params: Promise.resolve({ id: FILE_ID }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.url).toContain("short-lived=1");
    expect(storage.downloadStream).not.toHaveBeenCalled();
  });
});
