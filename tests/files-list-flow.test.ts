import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const requireReadActor = vi.fn();
vi.mock("@/lib/security/request-auth", () => ({ requireReadActor }));
vi.mock("@/lib/security/rate-limit", () => ({ enforceRateLimit: vi.fn() }));

/**
 * In-memory Firestore stand-in for the `files` collection.
 *
 * It models the two behaviours the Files page depends on:
 *  - `where(status) + orderBy(createdAt)` needs a composite index, which the
 *    fake can be told to reject with FAILED_PRECONDITION exactly like a
 *    project whose `firestore.indexes.json` was never deployed;
 *  - `where(status)` alone is served by the automatic single-field index, so
 *    the index-free read always succeeds.
 */
type Row = { id: string; data: Record<string, unknown> };

interface FakeOptions {
  /** Thrown by any `.get()` on an ordered query (missing composite index). */
  failOrdered?: Error;
  /** Thrown by every read (dependency outage). */
  failAll?: Error;
}

function makeFakeFirestore(rows: Row[], options: FakeOptions = {}) {
  const calls: string[] = [];
  const snapshot = (matched: Row[]) => ({
    size: matched.length,
    empty: matched.length === 0,
    docs: matched.map((row) => ({
      id: row.id,
      exists: true,
      data: () => row.data,
      ref: { id: row.id },
    })),
  });

  const query = (filter: (row: Row) => boolean, ordered: boolean) => ({
    where: (field: string, _op: string, value: unknown) =>
      query((row) => filter(row) && row.data[field] === value, ordered),
    orderBy: () => query(filter, true),
    startAfter: () => query(filter, ordered),
    limit: (limit: number) => ({
      get: async () => {
        calls.push(ordered ? "ordered" : "unordered");
        if (options.failAll) throw options.failAll;
        if (ordered && options.failOrdered) throw options.failOrdered;
        return snapshot(rows.filter(filter).slice(0, limit));
      },
    }),
  });

  const db = {
    collection: (name: string) => {
      if (name !== "files") throw new Error(`unexpected collection read: ${name}`);
      return {
        ...query(() => true, false),
        doc: (id: string) => {
          const row = rows.find((candidate) => candidate.id === id);
          return { id, get: async () => (row ? { exists: true, id, data: () => row.data } : { exists: false, id }) };
        },
      };
    },
  };
  return { db, calls };
}

const fakeState: { current: ReturnType<typeof makeFakeFirestore> } = {
  current: makeFakeFirestore([]),
};
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => fakeState.current.db }));

const { GET } = await import("@/app/api/files/route");

/** Distinct createdAt per row so "newest" ordering is deterministic in both read paths. */
const CREATED_AT: Record<string, Date> = {
  "file-a": new Date("2026-09-03T10:00:00.000Z"),
  "file-b": new Date("2026-09-01T10:00:00.000Z"),
};

function fileRow(id: string, overrides: Record<string, unknown> = {}): Row {
  const now = CREATED_AT[id] ?? new Date("2026-09-01T10:00:00.000Z");
  return {
    id,
    data: {
      storagePath: `pdfs/2026/09/${id}.pdf`,
      blobUrl: null,
      uploadKey: null,
      originalName: `${id}.pdf`,
      title: id,
      description: "",
      category: "Reports",
      tags: ["annual"],
      mimeType: "application/pdf",
      extension: "pdf",
      size: 2048,
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
    },
  };
}

function listRequest(search = ""): Request {
  return new Request(`https://gateway.example.org/api/files?pageSize=25&status=active&filter=all&sort=newest${search}`, {
    headers: { cookie: "ngo_gateway_session=admin" },
  });
}

const MISSING_INDEX = Object.assign(
  new Error(
    "9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://console.firebase.google.com/v1/r/project/am-st-b507f/firestore/indexes?create_composite=abc",
  ),
  { code: 9 },
);

const UNAVAILABLE = Object.assign(new Error("14 UNAVAILABLE: Firestore is unreachable from this runtime"), { code: 14 });

describe("GET /api/files — real Firestore metadata, never a masked failure", () => {
  let errorLogs: string[];
  let warnLogs: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    errorLogs = [];
    warnLogs = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errorLogs.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnLogs.push(args.map(String).join(" "));
    });
    requireReadActor.mockResolvedValue({ uid: "admin-1", email: "a@ngo.example", role: "admin", type: "admin" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the real documents from the `files` collection with pagination", async () => {
    fakeState.current = makeFakeFirestore([fileRow("file-a"), fileRow("file-b")]);

    const response = await GET(listRequest());
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.data.files.map((file: { id: string }) => file.id)).toEqual(["file-a", "file-b"]);
    expect(body.data.files[0].storagePath).toBeUndefined(); // private Blob path never leaves the server
    expect(body.data.pagination).toEqual({ count: 2, pageSize: 25, nextCursor: null, hasMore: false });
    expect(body.data.degraded).toBe(false);
    expect(body.requestId).toBeTruthy();
    expect(fakeState.current.calls).toContain("ordered");
  });

  it("still serves real data when the composite index is missing, and says which index to deploy", async () => {
    fakeState.current = makeFakeFirestore([fileRow("file-a"), fileRow("file-b")], { failOrdered: MISSING_INDEX });

    const response = await GET(listRequest());
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.data.files.map((file: { id: string }) => file.id)).toEqual(["file-a", "file-b"]);
    expect(body.data.degraded).toBe(true);
    // The index-free retry must have happened, not a fallback dataset.
    expect(fakeState.current.calls).toEqual(["ordered", "unordered"]);
    expect(warnLogs.join("\n")).toContain("firebase deploy --only firestore:indexes");
    expect(warnLogs.join("\n")).toContain("console.firebase.google.com");
  });

  it("reports the real Firestore error instead of hiding it behind a generic 503", async () => {
    fakeState.current = makeFakeFirestore([fileRow("file-a")], { failAll: UNAVAILABLE });

    const response = await GET(listRequest());
    expect(response.status).toBe(503);

    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("FILES_FETCH_FAILED");
    expect(body.error.message).toBe("Unable to load files. The file metadata store did not answer.");
    expect(body.error.details.causeCode).toBe("FIRESTORE_UNAVAILABLE");
    expect(body.error.details.cause).toContain("Firestore is unreachable from this runtime");
    expect(body.error.details.retryable).toBe(true);
    expect(body.error.requestId).toBe(body.requestId);

    // The same real cause must be in the server logs, tagged with the requestId.
    const logLine = errorLogs.find((line) => line.includes("Dependency operation failed"));
    expect(logLine).toBeTruthy();
    expect(logLine).toContain(body.requestId);
    expect(logLine).toContain("Firestore is unreachable from this runtime");
  });

  it("turns a permission-denied credential into actionable guidance", async () => {
    const denied = Object.assign(new Error("7 PERMISSION_DENIED: Missing or insufficient permissions."), { code: 7 });
    fakeState.current = makeFakeFirestore([fileRow("file-a")], { failAll: denied });

    const response = await GET(listRequest());
    const body = await response.json();
    expect(response.status).toBe(503);
    expect(body.error.details.causeCode).toBe("FIRESTORE_PERMISSION_DENIED");
    expect(body.error.details.hint).toContain("FIREBASE_PROJECT_ID");
  });

  it("keeps working for search queries, which read the same real documents", async () => {
    fakeState.current = makeFakeFirestore([
      fileRow("file-a", { originalName: "annual-report.pdf", title: "Annual report", tags: ["annual", "finance"] }),
      fileRow("file-b", { originalName: "board-minutes.pdf", title: "Board minutes", tags: ["governance"] }),
    ]);

    const response = await GET(listRequest("&search=annual"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.files.map((file: { id: string }) => file.id)).toEqual(["file-a"]);
    expect(body.data.searchLimited).toBe(false);
  });
});
