import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const requireAdminRequest = vi.fn();
vi.mock("@/lib/security/request-auth", () => ({ requireAdminRequest }));
vi.mock("@/lib/security/rate-limit", () => ({ enforceRateLimit: vi.fn() }));
vi.mock("@/lib/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn() }));

const storage = {
  getMetadata: vi.fn(),
  download: vi.fn(),
  delete: vi.fn(),
};
vi.mock("@/lib/storage", () => ({ getStorageService: () => storage }));

/**
 * In-memory Firestore for the `files` collection, including transactions.
 * `failTransaction` reproduces the case that matters here: the PDF is already
 * in Vercel Blob and only the Firestore metadata write fails.
 */
const state: {
  docs: Map<string, Record<string, unknown>>;
  failTransaction: Error | null;
  writes: Array<{ id: string; fields: Record<string, unknown> }>;
} = { docs: new Map(), failTransaction: null, writes: [] };

function makeDb() {
  const snapshotFor = (id: string) => {
    const data = state.docs.get(id);
    return { exists: Boolean(data), id, data: () => (data ? { ...data } : undefined), ref: { id } };
  };
  return {
    // Collection name is irrelevant here: only `files` and `auditLogs` are read.
    collection: () => ({
      doc: (id: string) => ({
        id,
        get: async () => snapshotFor(id),
        set: async (fields: Record<string, unknown>, options?: { merge?: boolean }) => {
          state.writes.push({ id, fields });
          const existing = state.docs.get(id) ?? {};
          state.docs.set(id, options?.merge ? { ...existing, ...fields } : fields);
        },
      }),
      add: async () => ({ id: "audit-1" }),
      where: () => ({ limit: () => ({ get: async () => ({ size: 0, empty: true, docs: [] }) }) }),
    }),
    runTransaction: async (fn: (transaction: unknown) => Promise<unknown>) => {
      if (state.failTransaction) throw state.failTransaction;
      const transaction = {
        get: async (ref: { id: string }) => snapshotFor(ref.id),
        update: (ref: { id: string }, fields: Record<string, unknown>) => {
          state.writes.push({ id: ref.id, fields });
          state.docs.set(ref.id, { ...(state.docs.get(ref.id) ?? {}), ...fields });
        },
      };
      return fn(transaction);
    },
  };
}

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => makeDb() }));

const { POST } = await import("@/app/api/files/[id]/complete/route");

const PDF_FIRST = new TextEncoder().encode("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n");
const PDF_LAST = new TextEncoder().encode("xref\n0 1\ntrailer\nstartxref\n0\n%%EOF\n");
const FILE_ID = "file-abc123";

function seedUploadingFile(): void {
  const now = new Date("2026-09-05T09:00:00.000Z");
  state.docs.set(FILE_ID, {
    storagePath: `pdfs/2026/09/${FILE_ID}.pdf`,
    blobUrl: null,
    uploadKey: null,
    originalName: "report.pdf",
    title: "report",
    description: "",
    category: "",
    tags: [],
    mimeType: "application/pdf",
    extension: "pdf",
    size: 4096,
    contentHash: null,
    createdAt: now,
    updatedAt: now,
    uploadedBy: "admin-1",
    isFavorite: false,
    autoDeleteEnabled: false,
    retentionType: "never",
    customDeleteAt: null,
    deleteAt: null,
    status: "uploading",
    deletedAt: null,
    deletedBy: null,
    permanentDeleteAt: null,
    permanentlyDeletedAt: null,
    deletionStartedAt: null,
    deletionPreviousStatus: null,
    deletionReason: null,
    uploadExpiresAt: new Date("2026-09-05T09:20:00.000Z"),
    validatedAt: null,
    lastAccessedAt: null,
    lastDownloadedAt: null,
    failureCode: null,
    version: 1,
  });
}

function completeRequest(): Request {
  return new Request(`https://gateway.example.org/api/files/${FILE_ID}/complete`, {
    method: "POST",
    headers: {
      cookie: "ngo_gateway_session=admin",
      origin: "https://gateway.example.org",
      "content-type": "application/json",
    },
    body: "{}",
  });
}

const UNAVAILABLE = Object.assign(new Error("14 UNAVAILABLE: Could not reach Firestore to finalize metadata"), { code: 14 });

describe("POST /api/files/:id/complete — Blob bytes plus Firestore metadata, or an explicit orphan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.docs.clear();
    state.writes.length = 0;
    state.failTransaction = null;
    requireAdminRequest.mockResolvedValue({ uid: "admin-1", email: "a@ngo.example", role: "admin", type: "admin" });
    seedUploadingFile();
    storage.getMetadata.mockResolvedValue({ contentLength: 4096, contentType: "application/pdf" });
    storage.download.mockImplementation(async (_path: string, range?: string) =>
      range === "bytes=-2048" ? PDF_LAST : PDF_FIRST,
    );
    storage.delete.mockResolvedValue(undefined);
  });

  it("activates the file only after the metadata write succeeds", async () => {
    const response = await POST(completeRequest(), { params: Promise.resolve({ id: FILE_ID }) });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.data.file.status).toBe("active");
    expect(body.data.file.id).toBe(FILE_ID);
    expect(state.docs.get(FILE_ID)?.status).toBe("active");
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it("marks the upload orphaned and keeps the Blob bytes when the metadata write fails", async () => {
    state.failTransaction = UNAVAILABLE;
    const errorLogs: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errorLogs.push(args.map(String).join(" "));
    });

    const response = await POST(completeRequest(), { params: Promise.resolve({ id: FILE_ID }) });
    expect(response.status).toBe(503);

    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("FILES_METADATA_FINALIZE_FAILED");
    expect(body.error.details.cause).toContain("Could not reach Firestore to finalize metadata");
    expect(body.error.details.orphaned).toBe(true);
    expect(body.error.details.retryable).toBe(true);
    expect(body.error.details.fileId).toBe(FILE_ID);

    // The uploaded PDF must survive so /complete can be retried.
    expect(storage.delete).not.toHaveBeenCalled();

    // The record is flagged orphaned and stays retryable (still `uploading`).
    const record = state.docs.get(FILE_ID);
    expect(record?.status).toBe("uploading");
    expect(record?.failureCode).toBe("METADATA_FINALIZE_FAILED");
    expect(record?.orphanedAt).toBeInstanceOf(Date);
    expect((record?.uploadExpiresAt as Date).getTime()).toBeGreaterThan(Date.parse("2026-09-05T09:20:00.000Z"));

    expect(errorLogs.join("\n")).toContain("Could not reach Firestore to finalize metadata");
    expect(errorLogs.join("\n")).toContain(FILE_ID);
    errorSpy.mockRestore();
  });

  it("lets a retried finalization finish once Firestore answers again", async () => {
    state.failTransaction = UNAVAILABLE;
    const first = await POST(completeRequest(), { params: Promise.resolve({ id: FILE_ID }) });
    expect(first.status).toBe(503);

    state.failTransaction = null;
    const retry = await POST(completeRequest(), { params: Promise.resolve({ id: FILE_ID }) });
    expect(retry.status).toBe(200);
    expect((await retry.json()).data.file.status).toBe("active");
  });
});
