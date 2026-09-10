import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const route = await import("@/app/api/v1/[...path]/route");

describe("GET/POST /api/v1/* — bridge routes are not served by the Next.js gateway", () => {
  const originalPublicBridgeUrl = process.env.NEXT_PUBLIC_BRIDGE_URL;

  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_BRIDGE_URL;
  });

  afterEach(() => {
    process.env.NEXT_PUBLIC_BRIDGE_URL = originalPublicBridgeUrl;
  });

  it("returns the JSON error envelope instead of the Next.js HTML 404 page", async () => {
    const request = new Request("https://gateway.example/api/v1/storage/upload", {
      method: "POST",
      headers: { "Content-Type": "multipart/form-data", "X-Request-Id": "req-123" },
    });

    const response = await route.POST(request);

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("BRIDGE_ENDPOINT_NOT_AT_GATEWAY");
    expect(body.error.message).toContain("AM Storage Bridge (FastAPI)");
    expect(body.requestId).toBe("req-123");
  });

  it("mentions the configured bridge origin when one is set", async () => {
    process.env.NEXT_PUBLIC_BRIDGE_URL = "https://bridge.example.com";
    const request = new Request("https://gateway.example/api/v1/storage/upload", {
      method: "POST",
    });

    const response = await route.POST(request);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.message).toContain("https://bridge.example.com");
  });

  it("handles other methods without throwing", async () => {
    const request = new Request("https://gateway.example/api/v1/storage/upload", { method: "GET" });

    expect((await route.GET(request)).status).toBe(404);
    expect((await route.PUT(request)).status).toBe(404);
    expect((await route.PATCH(request)).status).toBe(404);
    expect((await route.DELETE(request)).status).toBe(404);
    expect((await route.OPTIONS(request)).status).toBe(404);
    expect((await route.HEAD(request)).status).toBe(404);
  });
});
