import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const route = await import("@/app/api/v1/storage/upload/route");

describe("POST /api/v1/storage/upload gateway proxy", () => {
  const originalBridgeUrl = process.env.NEXT_PUBLIC_BRIDGE_URL;
  const fetchMock = vi.fn();

  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_BRIDGE_URL;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    process.env.NEXT_PUBLIC_BRIDGE_URL = originalBridgeUrl;
    vi.restoreAllMocks();
  });

  it("returns the JSON diagnostic when no bridge origin is configured", async () => {
    const response = await route.POST(new Request("https://gateway.example/api/v1/storage/upload", { method: "POST" }));

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("BRIDGE_ENDPOINT_NOT_AT_GATEWAY");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards multipart uploads to the configured FastAPI bridge and relays its response", async () => {
    process.env.NEXT_PUBLIC_BRIDGE_URL = "https://bridge.example.org";
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true }), {
      status: 201,
      headers: { "Content-Type": "application/json", "X-Request-Id": "bridge-req-1" },
    }));

    const upstream = new Request("https://gateway.example/api/v1/storage/upload", {
      method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=x", "X-AM-Storage-Key-Id": "am_store_live_test" },
      body: "multipart-body",
    });
    const response = await route.POST(upstream);

    expect(response.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://bridge.example.org/api/v1/storage/upload",
      expect.objectContaining({ method: "POST" }),
    );
    const body = await response.json();
    expect(body).toEqual({ success: true });
  });

  it("forwards GET requests using the original method", async () => {
    process.env.NEXT_PUBLIC_BRIDGE_URL = "https://bridge.example.org";
    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

    const response = await route.GET(new Request("https://gateway.example/api/v1/storage/upload", { method: "GET" }));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://bridge.example.org/api/v1/storage/upload",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("returns BRIDGE_UNAVAILABLE when the bridge cannot be reached", async () => {
    process.env.NEXT_PUBLIC_BRIDGE_URL = "https://bridge.example.org";
    fetchMock.mockRejectedValue(new Error("connection refused"));

    const response = await route.POST(new Request("https://gateway.example/api/v1/storage/upload", { method: "POST" }));

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error.code).toBe("BRIDGE_UNAVAILABLE");
  });
});
