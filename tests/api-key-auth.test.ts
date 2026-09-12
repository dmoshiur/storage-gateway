import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression tests for external API-key authentication.
 *
 * The production bug: the dashboard issues keys with `kind = 'bearer'`, but the
 * `X-AM-Storage-Key-Id` / `X-AM-Storage-Key-Secret` lookup filtered on
 * `kind = 'bridge'`. Every real key therefore missed its own row and every
 * external upload was rejected with 401.
 *
 * The database layer is stubbed so these tests assert the exact SQL predicate
 * and the fail-closed authorization rules without needing a live database.
 */

const executed: { sql: string; args: unknown[] }[] = [];
let rows: Record<string, unknown>[] = [];

vi.mock("@/lib/db/client", () => ({
  query: vi.fn(async (sql: string, args: unknown[] = []) => {
    executed.push({ sql, args });
    return { rows, rowCount: rows.length };
  }),
  toDate: (value: unknown) => {
    if (value instanceof Date) return value;
    if (typeof value === "string" || typeof value === "number") {
      const date = new Date(value);
      return Number.isFinite(date.getTime()) ? date : null;
    }
    return null;
  },
  SQL_NOW: "now",
}));

vi.mock("@/lib/db/api-metrics", () => ({ recordApiRequestSafe: vi.fn(async () => undefined) }));

const { createHash } = await import("node:crypto");
const { verifyApiCredentialDetailed, getApiKeyScopes, requireScope } = await import("@/lib/security/api-keys");

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const KEY_ID = "ng_key_Test123456";
const SECRET = "ng_live_super-secret-value";

function keyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "record-1",
    key_id: KEY_ID,
    secret_hash: sha256(SECRET),
    scopes: ["files:upload"],
    expires_at: null,
    revoked_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  executed.length = 0;
  rows = [];
});

describe("dual-token API key verification", () => {
  it("does not restrict the key lookup to a single kind", async () => {
    rows = [keyRow()];
    await verifyApiCredentialDetailed(KEY_ID, SECRET);
    const lookup = executed[0]!.sql;
    expect(lookup).toContain("FROM api_keys WHERE key_id");
    // The regression: a `kind = 'bridge'` filter hides dashboard-issued keys.
    expect(lookup).not.toContain("kind = 'bridge'");
  });

  it("authenticates a dashboard-issued key and returns its scopes", async () => {
    rows = [keyRow()];
    const { credential, rejection } = await verifyApiCredentialDetailed(KEY_ID, SECRET);
    expect(rejection).toBeNull();
    expect(credential).not.toBeNull();
    expect(credential!.recordId).toBe("record-1");
    expect(credential!.keyId).toBe(KEY_ID);
    expect(credential!.scopes).toEqual(["files:upload"]);
  });

  it("reports a precise reason for each rejection without authenticating", async () => {
    const cases: [Record<string, unknown> | null, string][] = [
      [null, "not_found"],
      [{ revoked_at: "2020-01-01T00:00:00.000Z" }, "revoked"],
      [{ expires_at: "2020-01-01T00:00:00.000Z" }, "expired"],
    ];
    for (const [overrides, expected] of cases) {
      rows = overrides === null ? [] : [keyRow(overrides)];
      const { credential, rejection } = await verifyApiCredentialDetailed(KEY_ID, SECRET);
      expect(credential).toBeNull();
      expect(rejection).toBe(expected);
    }
  });

  it("rejects a valid key id presented with the wrong secret", async () => {
    rows = [keyRow()];
    const { credential, rejection } = await verifyApiCredentialDetailed(KEY_ID, "ng_live_wrong");
    expect(credential).toBeNull();
    expect(rejection).toBe("bad_secret");
  });

  it("decodes scopes stored as a JSON string", async () => {
    rows = [keyRow({ scopes: '["files:upload","files:read"]' })];
    const { credential } = await verifyApiCredentialDetailed(KEY_ID, SECRET);
    expect(credential!.scopes).toEqual(["files:upload", "files:read"]);
  });
});

describe("authorization is fail-closed", () => {
  it("grants no scopes for an unknown record", async () => {
    rows = [];
    await expect(getApiKeyScopes("missing")).resolves.toEqual([]);
  });

  it("grants no scopes when the stored list is unreadable or empty", async () => {
    for (const scopes of [null, "not json", "{}", []]) {
      rows = [{ scopes }];
      // An unreadable scope list must never be treated as "all scopes".
      await expect(getApiKeyScopes("record-1")).resolves.toEqual([]);
    }
  });

  it("discards unrecognised scope values", async () => {
    rows = [{ scopes: ["files:upload", "files:*", "admin"] }];
    await expect(getApiKeyScopes("record-1")).resolves.toEqual(["files:upload"]);
  });

  it("requireScope rejects a key that lacks the scope with 403", () => {
    expect(() => requireScope(["files:read"], "files:upload")).toThrowError(
      expect.objectContaining({ status: 403, code: "INSUFFICIENT_SCOPE" }),
    );
    expect(() => requireScope([], "files:upload")).toThrowError(expect.objectContaining({ status: 403 }));
    expect(() => requireScope(["files:upload"], "files:upload")).not.toThrow();
  });
});
