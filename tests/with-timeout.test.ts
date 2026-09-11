import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { withTimeout } = await import("@/lib/firestore/with-timeout");

/**
 * The Admin SDK retries an unreachable Firestore for minutes. Any request that
 * awaits such a call unbounded stalls with it — login was measured at 4.3
 * minutes when the database was unreachable, which looks like a dead app rather
 * than a database problem.
 */
describe("withTimeout", () => {
  it("returns the operation result when it settles in time", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 1000, "test")).resolves.toBe("ok");
  });

  it("propagates the operation's own error when it fails in time", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 1000, "test")).rejects.toThrow("boom");
  });

  it("rejects with FIRESTORE_TIMEOUT instead of hanging when the operation stalls", async () => {
    const never = new Promise<string>(() => undefined);
    const started = Date.now();

    await expect(withTimeout(never, 40, "test:stalled")).rejects.toMatchObject({
      status: 504,
      code: "FIRESTORE_TIMEOUT",
      details: { timeoutMs: 40, label: "test:stalled", retryable: true },
    });
    // Must fail at the bound, not after the SDK gives up on its own.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("names the stalled operation in the message", async () => {
    const never = new Promise<string>(() => undefined);
    await expect(withTimeout(never, 30, "system/health:files-probe")).rejects.toThrow(
      "Firestore did not respond within 30 ms (system/health:files-probe).",
    );
  });
});
