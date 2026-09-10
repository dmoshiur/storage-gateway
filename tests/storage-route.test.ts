import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const requireAdminRequest = vi.fn();
vi.mock("@/lib/security/request-auth", () => ({ requireAdminRequest }));
vi.mock("@/lib/security/rate-limit", () => ({ enforceRateLimit: vi.fn() }));

const getStorageStatsSafe = vi.fn();
vi.mock("@/lib/firestore/stats", () => ({ getStorageStatsSafe }));

const getApiRequestTotals = vi.fn();
vi.mock("@/lib/firestore/api-metrics", () => ({ getApiRequestTotals }));

const getStorageService = vi.fn();
vi.mock("@/lib/storage/index", () => ({ getStorageService }));

const storageRoute = await import("@/app/api/storage/route");

const LIVE_STATS = {
  totalPdfCount: 3,
  activeFileCount: 2,
  trashFileCount: 1,
  totalStorageBytes: 1024,
  storageLimitBytes: 10 * 1024 * 1024 * 1024,
  activeStorageBytes: 1024,
  trashStorageBytes: 0,
  availableBytes: 10 * 1024 * 1024 * 1024 - 1024,
  usagePercent: 0,
  warningLevel: "normal",
  expiringSoonCount: 0,
  pendingUploadBytes: 0,
};

function adminRequest(): Request {
  return new Request("https://storage.example.org/api/storage", {
    headers: { cookie: "ngo_gateway_session=admin" },
  });
}

describe("GET /api/storage — dashboard initialization never 500s", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAdminRequest.mockResolvedValue({ uid: "admin-1", email: "a@ngo.example", role: "admin", type: "admin" });
  });

  it("returns live stats, Blob health, and API request totals on a healthy system", async () => {
    getStorageStatsSafe.mockResolvedValue({ stats: LIVE_STATS, source: "live" });
    getApiRequestTotals.mockResolvedValue({ totalRequests: 42, lastRequestDate: "2026-09-09" });
    getStorageService.mockReturnValue({ healthCheck: vi.fn(async () => ({ reachable: true, latencyMs: 12, checkedAt: "2026-09-09T00:00:00.000Z" })) });

    const response = await storageRoute.GET(adminRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.data.stats).toEqual(LIVE_STATS);
    expect(body.data.source).toBe("live");
    expect(body.data.blob.reachable).toBe(true);
    expect(body.data.apiRequests).toEqual({ totalRequests: 42, lastRequestDate: "2026-09-09" });
  });

  it("serves fallback metrics (0 files, 0 bytes) when Firestore is unreachable", async () => {
    getStorageStatsSafe.mockResolvedValue({
      stats: { ...LIVE_STATS, totalPdfCount: 0, totalStorageBytes: 0, activeFileCount: 0, trashFileCount: 0 },
      source: "fallback",
    });
    getApiRequestTotals.mockResolvedValue({ totalRequests: 0, lastRequestDate: null });
    getStorageService.mockReturnValue({ healthCheck: vi.fn(async () => ({ reachable: false, latencyMs: 0, checkedAt: "2026-09-09T00:00:00.000Z" })) });

    const response = await storageRoute.GET(adminRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.source).toBe("fallback");
    expect(body.data.stats.totalPdfCount).toBe(0);
    expect(body.data.stats.totalStorageBytes).toBe(0);
    expect(body.data.blob.reachable).toBe(false);
  });

  it("swallows Blob health-check throws so the dashboard still renders", async () => {
    getStorageStatsSafe.mockResolvedValue({ stats: LIVE_STATS, source: "live" });
    getApiRequestTotals.mockRejectedValue(new Error("Firestore unavailable"));
    getStorageService.mockReturnValue({ healthCheck: vi.fn(async () => { throw new Error("Blob timeout"); }) });

    const response = await storageRoute.GET(adminRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.blob.reachable).toBe(false);
    expect(body.data.apiRequests).toEqual({ totalRequests: 0, lastRequestDate: null });
    expect(body.data.source).toBe("live");
  });

  it("keeps enforcing admin authorization before serving any metrics", async () => {
    const { ApiError } = await import("@/lib/api/errors");
    requireAdminRequest.mockRejectedValue(new ApiError(401, "UNAUTHENTICATED", "Please sign in to continue."));
    getStorageStatsSafe.mockResolvedValue({ stats: LIVE_STATS, source: "live" });

    const response = await storageRoute.GET(adminRequest());
    expect(response.status).toBe(401);
    expect(getStorageStatsSafe).not.toHaveBeenCalled();
  });
});
