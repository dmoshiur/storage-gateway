import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// In-memory stand-in for the Firestore `apiKeys` collection.
function makeFakeDb() {
  const docs = new Map<string, Record<string, unknown>>();
  const ref = (id: string) => ({
    id,
    update: async (fields: Record<string, unknown>) => {
      Object.assign(docs.get(id) ?? {}, fields);
    },
  });
  const result = (matched: Array<[string, Record<string, unknown>]>) => ({
    empty: matched.length === 0,
    docs: matched.map(([id, data]) => ({ id, data: () => data, ref: ref(id) })),
  });
  return {
    docs,
    collection: () => ({
      add: async (data: Record<string, unknown>) => {
        const id = `doc-${docs.size + 1}`;
        docs.set(id, { ...data });
        return ref(id);
      },
      where: (field: string, _op: string, value: unknown) => ({
        limit: () => ({ get: async () => result([...docs.entries()].filter(([, d]) => d[field] === value)) }),
      }),
      orderBy: () => ({ get: async () => result([...docs.entries()]) }),
      doc: (id: string) => ref(id),
    }),
  };
}

const fakeDb = makeFakeDb();
const recordApiRequestSafe = vi.fn(async () => undefined);
// 32 bytes — valid AES-256 master key. Toggled per test for the "not enabled" path.
const getMasterKey = vi.fn<() => Buffer | null>(() => Buffer.alloc(32));

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => fakeDb }));
vi.mock("@/lib/firestore/api-metrics", () => ({ recordApiRequestSafe }));
vi.mock("@/lib/env", () => ({ getMasterKey }));

const {
  API_KEY_ID_PREFIX,
  API_SECRET_PREFIX,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  verifyApiKey,
  verifyApiCredential,
  verifyApiSignature,
} = await import("@/lib/security/api-keys");

describe("dual-token API credentials", () => {
  beforeEach(() => {
    fakeDb.docs.clear();
    vi.clearAllMocks();
    getMasterKey.mockReturnValue(Buffer.alloc(32));
  });

  it("creates a visible key id and a high-entropy secret shown only once", async () => {
    const created = await createApiKey("admin-1");
    expect(created.id).toBeTruthy();
    expect(created.keyId).toMatch(/^am_store_live_[A-Za-z0-9_-]{16}$/);
    expect(created.keySecret).toMatch(/^am_sec_live_[A-Za-z0-9_-]{43}$/);

    const stored = [...fakeDb.docs.values()][0]!;
    expect(stored.keyId).toBe(created.keyId);
    expect(stored.secretHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.secretEncrypted).toBeTruthy();
    // Raw material must never be persisted.
    expect(JSON.stringify(stored)).not.toContain(created.keySecret);
  });

  it("verifies the dual-token pair by digest and refreshes lastUsedAt", async () => {
    const created = await createApiKey("admin-1");
    const recordId = await verifyApiCredential(created.keyId, created.keySecret);
    expect(recordId).toBe(created.id);
    expect(fakeDb.docs.get(created.id)!.lastUsedAt).toBeInstanceOf(Date);
    expect(recordApiRequestSafe).toHaveBeenCalledWith(created.keyId);
  });

  it("rejects a wrong secret, an unknown key id, and a revoked credential", async () => {
    const created = await createApiKey("admin-1");
    expect(await verifyApiCredential(created.keyId, "am_sec_live_totally_wrong_secret_value_123")).toBeNull();
    expect(await verifyApiCredential("am_store_live_doesnotexist12", created.keySecret)).toBeNull();

    await revokeApiKey(created.id);
    expect(await verifyApiCredential(created.keyId, created.keySecret)).toBeNull();
    expect(recordApiRequestSafe).not.toHaveBeenCalled();
  });

  it("accepts a valid HMAC signed request within the clock-skew window", async () => {
    const created = await createApiKey("admin-1");
    const timestamp = Date.now();
    const bodyHash = "a".repeat(64);
    const signature = createHmac("sha256", created.keySecret).update(`${timestamp}:${bodyHash}`).digest("hex");
    const recordId = await verifyApiSignature({ keyId: created.keyId, timestamp, signature, bodyHash });
    expect(recordId).toBe(created.id);
    expect(recordApiRequestSafe).toHaveBeenCalledWith(created.keyId);
  });

  it("reports signature verification unavailable when no master key is configured", async () => {
    getMasterKey.mockReturnValue(null);
    const created = await createApiKey("admin-1");
    expect([...fakeDb.docs.values()][0]!.secretEncrypted).toBeUndefined();

    const timestamp = Date.now();
    const bodyHash = "a".repeat(64);
    const signature = createHmac("sha256", created.keySecret).update(`${timestamp}:${bodyHash}`).digest("hex");
    await expect(verifyApiSignature({ keyId: created.keyId, timestamp, signature, bodyHash }))
      .rejects.toMatchObject({ code: "SIGNATURE_VERIFICATION_UNAVAILABLE" });
    // Dual-token mode keeps working without a master key (digest only).
    expect(await verifyApiCredential(created.keyId, created.keySecret)).toBe(created.id);
  });

  it("rejects stale timestamps and tampered bodies", async () => {
    const created = await createApiKey("admin-1");
    const bodyHash = "b".repeat(64);
    const staleTimestamp = Date.now() - 6 * 60 * 1000; // outside the 5 minute window
    const staleSignature = createHmac("sha256", created.keySecret).update(`${staleTimestamp}:${bodyHash}`).digest("hex");
    expect(await verifyApiSignature({ keyId: created.keyId, timestamp: staleTimestamp, signature: staleSignature, bodyHash })).toBeNull();

    const timestamp = Date.now();
    const goodSignature = createHmac("sha256", created.keySecret).update(`${timestamp}:${bodyHash}`).digest("hex");
    expect(await verifyApiSignature({ keyId: created.keyId, timestamp, signature: goodSignature, bodyHash: "c".repeat(64) })).toBeNull();
    expect(await verifyApiSignature({ keyId: created.keyId, timestamp, signature: "z".repeat(64), bodyHash })).toBeNull();
  });

  it("still verifies legacy single keys and lists them with a null key id", async () => {
    const legacyKey = `${API_KEY_ID_PREFIX}legacy_key_value_for_tests_123`;
    const { createHash } = await import("node:crypto");
    fakeDb.docs.set("legacy-1", {
      keyHash: createHash("sha256").update(legacyKey).digest("hex"),
      prefix: legacyKey.slice(0, 22),
      createdAt: new Date(),
      createdBy: "admin-1",
      revokedAt: null,
    });

    expect(await verifyApiKey(legacyKey)).toBe("legacy-1");
    expect(recordApiRequestSafe).toHaveBeenCalledWith("legacy");

    const listed = await listApiKeys();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.keyId).toBeNull();
    expect(listed[0]!.prefix).toBe(legacyKey.slice(0, 22));
  });

  it("lists dual-token keys by their visible key id", async () => {
    const created = await createApiKey("admin-1");
    const listed = await listApiKeys();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.keyId).toBe(created.keyId);
    expect(listed[0]!.prefix).toBe(created.keyId);
    expect(API_KEY_ID_PREFIX).toBe("am_store_live_");
    expect(API_SECRET_PREFIX).toBe("am_sec_live_");
  });
});
