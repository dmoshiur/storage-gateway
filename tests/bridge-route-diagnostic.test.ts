import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const route = await import("@/app/api/v1/[...path]/route");

describe("GET/POST /api/v1/* — unknown bridge subpaths return JSON (never HTML)", () => {
  it("returns the JSON error envelope instead of the Next.js HTML 404 page", async () => {
    const request = new Request("https://gateway.example/api/v1/storage/unknown", {
      method: "POST",
      headers: { "Content-Type": "multipart/form-data", "X-Request-Id": "req-123" },
    });

    const response = await route.POST(request);

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("UNKNOWN_BRIDGE_ROUTE");
    expect(body.error.message).toContain("/api/v1/storage/upload");
    expect(body.error.message).toContain("/api/v1/health");
    expect(body.error.message).toContain("same deployment");
    expect(body.requestId).toBe("req-123");
  });

  it("names the unmatched path so misconfigured integrations can self-diagnose", async () => {
    const request = new Request("https://gateway.example/api/v1/typo/path", { method: "GET" });

    const response = await route.GET(request);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.message).toContain("/api/v1/typo/path");
  });

  it("handles other methods without throwing", async () => {
    const request = new Request("https://gateway.example/api/v1/storage/unknown", { method: "GET" });

    expect((await route.GET(request)).status).toBe(404);
    expect((await route.PUT(request)).status).toBe(404);
    expect((await route.PATCH(request)).status).toBe(404);
    expect((await route.DELETE(request)).status).toBe(404);
    expect((await route.OPTIONS(request)).status).toBe(404);
    expect((await route.HEAD(request)).status).toBe(404);
  });
});
