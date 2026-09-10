import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const verifyApiCredential = vi.fn();
const verifyApiSignature = vi.fn();
const verifyApiKey = vi.fn();
vi.mock("@/lib/security/api-keys", () => ({ verifyApiCredential, verifyApiSignature, verifyApiKey }));

const recordApiRequestSafe = vi.fn();
vi.mock("@/lib/firestore/api-metrics", () => ({ recordApiRequestSafe }));

const { requireBridgeCredential, hasBridgeCredentialHeaders, bridgeLogKeyFromHeaders } = await import("@/lib/bridge/auth");
const { ApiError } = await import("@/lib/api/errors");

const KEY_ID = "am_store_live_kx8pQ2vN4rT7wZ9m";
const KEY_SECRET = "am_sec_live_xY9zW8vU7tS6rQ5pON4mLK3jI2hG1fE0dCbA9vN8mU7";

function bridgeRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://gateway.test/api/v1/storage/upload", { method: "POST", headers });
}

describe("embedded bridge credential verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AM_STORAGE_KEYS;
  });

  afterEach(() => {
    delete process.env.AM_STORAGE_KEYS;
  });

  it("rejects requests with no credential headers", async () => {
    await expect(requireBridgeCredential(bridgeRequest())).rejects.toMatchObject({
      status: 401,
      code: "INVALID_API_KEY",
    });
    expect(hasBridgeCredentialHeaders(bridgeRequest())).toBe(false);
    expect(bridgeLogKeyFromHeaders(bridgeRequest())).toBe("rejected");
  });

  it("rejects partial credentials (key id without a secret or signature)", async () => {
    await expect(requireBridgeCredential(bridgeRequest({ "X-AM-Storage-Key-Id": KEY_ID }))).rejects.toMatchObject({
      code: "INVALID_API_KEY",
    });
    expect(verifyApiCredential).not.toHaveBeenCalled();
  });

  it("verifies dual-token credentials and derives the log key", async () => {
    verifyApiCredential.mockResolvedValue("rec-1");

    const credential = await requireBridgeCredential(bridgeRequest({
      "X-AM-Storage-Key-Id": KEY_ID,
      "X-AM-Storage-Key-Secret": KEY_SECRET,
    }));

    expect(credential).toEqual({ mode: "dual_token", keyId: KEY_ID, legacyKey: null, logKey: KEY_ID });
    expect(verifyApiCredential).toHaveBeenCalledWith(KEY_ID, KEY_SECRET);
  });

  it("maps registry rejections to 401", async () => {
    verifyApiCredential.mockResolvedValue(null);

    await expect(requireBridgeCredential(bridgeRequest({
      "X-AM-Storage-Key-Id": KEY_ID,
      "X-AM-Storage-Key-Secret": "am_sec_live_wrong",
    }))).rejects.toMatchObject({ status: 401, code: "INVALID_API_KEY" });
  });

  it("verifies HMAC signatures over the caller-supplied raw body", async () => {
    verifyApiSignature.mockResolvedValue("rec-2");
    const raw = new TextEncoder().encode("exact-request-bytes");
    const bodyHash = createHash("sha256").update(raw).digest("hex");
    const timestamp = Date.now();

    const credential = await requireBridgeCredential(
      bridgeRequest({
        "X-AM-Storage-Key-Id": KEY_ID,
        "X-AM-Storage-Timestamp": String(timestamp),
        "X-AM-Storage-Signature": "a".repeat(64),
      }),
      raw,
    );

    expect(credential.mode).toBe("signature");
    expect(verifyApiSignature).toHaveBeenCalledWith({ keyId: KEY_ID, timestamp, signature: "a".repeat(64), bodyHash });
  });

  it("forwards second-precision timestamps untouched (the registry normalizes units)", async () => {
    verifyApiSignature.mockResolvedValue("rec-2");
    const timestamp = Math.floor(Date.now() / 1000);

    await requireBridgeCredential(
      bridgeRequest({
        "X-AM-Storage-Key-Id": KEY_ID,
        "X-AM-Storage-Timestamp": String(timestamp),
        "X-AM-Storage-Signature": "b".repeat(64),
      }),
      new Uint8Array(),
    );

    expect(verifyApiSignature).toHaveBeenCalledWith(expect.objectContaining({ timestamp }));
  });

  it("uses the empty-body hash for read-only requests without a body", async () => {
    verifyApiSignature.mockResolvedValue("rec-2");
    const emptyHash = createHash("sha256").update(new Uint8Array()).digest("hex");

    await requireBridgeCredential(bridgeRequest({
      "X-AM-Storage-Key-Id": KEY_ID,
      "X-AM-Storage-Timestamp": String(Date.now()),
      "X-AM-Storage-Signature": "c".repeat(64),
    }));

    expect(verifyApiSignature).toHaveBeenCalledWith(expect.objectContaining({ bodyHash: emptyHash }));
  });

  it("rejects non-numeric signature timestamps", async () => {
    await expect(requireBridgeCredential(bridgeRequest({
      "X-AM-Storage-Key-Id": KEY_ID,
      "X-AM-Storage-Timestamp": "yesterday",
      "X-AM-Storage-Signature": "c".repeat(64),
    }))).rejects.toMatchObject({ code: "INVALID_API_KEY" });
    expect(verifyApiSignature).not.toHaveBeenCalled();
  });

  it("verifies legacy single keys and truncates them for logs", async () => {
    verifyApiKey.mockResolvedValue("legacy-rec");
    const legacyKey = "am_store_live_legacy_value_for_tests";

    const credential = await requireBridgeCredential(bridgeRequest({ "X-AM-Storage-Key": legacyKey }));

    expect(credential.mode).toBe("legacy");
    expect(credential.logKey).toBe(`${legacyKey.slice(0, 16)}…`);
    expect(bridgeLogKeyFromHeaders(bridgeRequest({ "X-AM-Storage-Key": legacyKey }))).toBe(credential.logKey);
  });

  it("prefers the legacy header when several credential forms are present", async () => {
    verifyApiKey.mockResolvedValue("legacy-rec");

    await requireBridgeCredential(bridgeRequest({
      "X-AM-Storage-Key": "am_store_live_legacy",
      "X-AM-Storage-Key-Id": KEY_ID,
      "X-AM-Storage-Key-Secret": KEY_SECRET,
    }));

    expect(verifyApiKey).toHaveBeenCalledWith("am_store_live_legacy");
    expect(verifyApiCredential).not.toHaveBeenCalled();
  });

  it("accepts static legacy keys without a registry round-trip", async () => {
    process.env.AM_STORAGE_KEYS = " static-one ,static-two ";

    const credential = await requireBridgeCredential(bridgeRequest({ "X-AM-Storage-Key": "static-two" }));

    expect(credential.mode).toBe("static");
    expect(verifyApiKey).not.toHaveBeenCalled();
    expect(recordApiRequestSafe).toHaveBeenCalledWith("static");
  });

  it("accepts static dual-token secrets without a registry round-trip", async () => {
    process.env.AM_STORAGE_KEYS = "static-shared-secret";

    const credential = await requireBridgeCredential(bridgeRequest({
      "X-AM-Storage-Key-Id": KEY_ID,
      "X-AM-Storage-Key-Secret": "static-shared-secret",
    }));

    expect(credential).toEqual({ mode: "static", keyId: KEY_ID, legacyKey: null, logKey: KEY_ID });
    expect(verifyApiCredential).not.toHaveBeenCalled();
  });

  it("falls through to the registry when no static key matches", async () => {
    process.env.AM_STORAGE_KEYS = "static-one";
    verifyApiCredential.mockResolvedValue("rec-1");

    const credential = await requireBridgeCredential(bridgeRequest({
      "X-AM-Storage-Key-Id": KEY_ID,
      "X-AM-Storage-Key-Secret": KEY_SECRET,
    }));

    expect(credential.mode).toBe("dual_token");
    expect(verifyApiCredential).toHaveBeenCalled();
  });

  it("maps registry outages to 503 (never to a rejection)", async () => {
    verifyApiCredential.mockRejectedValue(new Error("firestore unavailable"));

    await expect(requireBridgeCredential(bridgeRequest({
      "X-AM-Storage-Key-Id": KEY_ID,
      "X-AM-Storage-Key-Secret": KEY_SECRET,
    }))).rejects.toMatchObject({ status: 503, code: "KEY_SERVICE_UNAVAILABLE" });
  });

  it("propagates registry ApiErrors (e.g. signature support unavailable) untouched", async () => {
    verifyApiSignature.mockRejectedValue(new ApiError(503, "SIGNATURE_VERIFICATION_UNAVAILABLE", "no master key"));

    await expect(requireBridgeCredential(
      bridgeRequest({
        "X-AM-Storage-Key-Id": KEY_ID,
        "X-AM-Storage-Timestamp": String(Date.now()),
        "X-AM-Storage-Signature": "d".repeat(64),
      }),
      new Uint8Array(),
    )).rejects.toMatchObject({ status: 503, code: "SIGNATURE_VERIFICATION_UNAVAILABLE" });
  });
});
