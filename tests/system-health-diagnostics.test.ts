import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const requireAdminRequest = vi.fn();
vi.mock("@/lib/security/request-auth", () => ({ requireAdminRequest }));
vi.mock("@/lib/security/rate-limit", () => ({ enforceRateLimit: vi.fn() }));

/** Firestore state: `failWith` reproduces an Admin SDK / database failure. */
const state: { failWith: Error | null; fileCount: number } = { failWith: null, fileCount: 3 };

const credential = { projectId: "am-st-b507f", credentialProjectId: "am-st-b507f", projectMatch: true as boolean | null };

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    collection: () => ({
      limit: () => ({
        get: async () => {
          if (state.failWith) throw state.failWith;
          return { size: state.fileCount, docs: [] };
        },
      }),
    }),
  }),
  describeAdminCredentialIdentity: () => ({ ...credential }),
}));

const healthCheck = vi.fn();
vi.mock("@/lib/storage", () => ({ getStorageService: () => ({ healthCheck }) }));

vi.mock("@/lib/firebase/runtime-store", () => ({
  getEffectiveFirebaseWebConfig: async () => ({
    configured: true,
    source: "env",
    config: { projectId: "am-st-b507f" },
    missing: [],
    hasStoredOverride: false,
    storedUpdatedAt: null,
    storedUpdatedBy: null,
    envDrift: false,
    redeployRequired: false,
    adminProjectId: "am-st-b507f",
    adminProjectMatch: true,
  }),
}));

vi.mock("@/lib/firestore/cleanup-lock", () => ({ getCleanupStatus: async () => null }));

const { GET } = await import("@/app/api/system/health/route");

function adminRequest(): Request {
  return new Request("https://gateway.example.org/api/system/health", {
    headers: { cookie: "ngo_gateway_session=admin" },
  });
}

describe("GET /api/system/health — Firestore diagnostics are never swallowed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.failWith = null;
    state.fileCount = 3;
    credential.projectId = "am-st-b507f";
    credential.credentialProjectId = "am-st-b507f";
    credential.projectMatch = true;
    process.env.FIREBASE_PROJECT_ID = "am-st-b507f";
    requireAdminRequest.mockResolvedValue({ uid: "admin-1", email: "a@ngo.example", role: "admin", type: "admin" });
    healthCheck.mockResolvedValue({ reachable: true, latencyMs: 8, checkedAt: "2026-09-09T00:00:00.000Z", error: null, authMode: "token" });
  });

  it("reports a healthy `files` collection read and the Admin SDK project id", async () => {
    const response = await GET(adminRequest());
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.data.status).toBe("healthy");
    expect(body.data.services.database).toMatchObject({
      status: "healthy",
      provider: "cloud-firestore",
      collection: "files",
      documentsRead: 3,
      adminProjectId: "am-st-b507f",
    });
    expect(body.data.services.database.error).toBeUndefined();
  });

  it("surfaces the real Firestore error, code, and fix instead of a bare connected:false", async () => {
    state.failWith = Object.assign(new Error("7 PERMISSION_DENIED: Missing or insufficient permissions."), { code: 7 });

    const response = await GET(adminRequest());
    const body = await response.json();

    expect(body.data.status).toBe("degraded");
    expect(body.data.services.database.status).toBe("degraded");
    expect(body.data.services.database.connected).toBeUndefined();
    expect(body.data.services.database.errorCode).toBe("FIRESTORE_PERMISSION_DENIED");
    expect(body.data.services.database.error).toContain("Missing or insufficient permissions");
    expect(body.data.services.database.hint).toContain("FIREBASE_PROJECT_ID");
    expect(body.data.services.database.adminProjectId).toBe("am-st-b507f");
  });

  it("points at the missing composite index when that is the real cause", async () => {
    state.failWith = Object.assign(
      new Error(
        "9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://console.firebase.google.com/v1/r/project/am-st-b507f/firestore/indexes?create_composite=x",
      ),
      { code: 9 },
    );

    const body = await (await GET(adminRequest())).json();
    expect(body.data.services.database.errorCode).toBe("FIRESTORE_FAILED_PRECONDITION");
    expect(body.data.services.database.hint).toContain("firebase deploy --only firestore:indexes");
    expect(body.data.services.database.hint).toContain("console.firebase.google.com");
  });

  it("never leaks the Blob credential while reporting Blob health", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_store123_supersecret";
    const body = await (await GET(adminRequest())).json();

    expect(body.data.services.blobStorage.status).toBe("healthy");
    expect(body.data.services.blobStorage.authMode).toBe("token");
    expect(JSON.stringify(body)).not.toContain("supersecret");
    delete process.env.BLOB_READ_WRITE_TOKEN;
  });

  it("reports which project the Admin SDK queries and which one the credential owns", async () => {
    const body = await (await GET(adminRequest())).json();
    expect(body.data.services.database.adminProjectId).toBe("am-st-b507f");
    expect(body.data.services.database.credentialProjectId).toBe("am-st-b507f");
    expect(body.data.services.database.credentialProjectMatch).toBe(true);
    expect(body.data.status).toBe("healthy");
  });

  it("degrades and names the mismatch when the credential is from another project", async () => {
    credential.credentialProjectId = "some-other-project";
    credential.projectMatch = false;

    const body = await (await GET(adminRequest())).json();
    // The Firestore read itself succeeds here; the misconfiguration alone must
    // still be reported, because it is what makes every other read 403.
    expect(body.data.status).toBe("degraded");
    expect(body.data.services.database.credentialProjectMatch).toBe(false);
    expect(body.data.services.database.credentialProjectId).toBe("some-other-project");
  });
});
