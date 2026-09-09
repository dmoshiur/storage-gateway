import { describe, expect, it } from "vitest";
import { isDueForAutomaticCleanup, isDueForTrashExpiry, isStaleUpload } from "@/lib/cleanup/eligibility";
import { canTransitionFileStatus } from "@/lib/files/lifecycle";

const now = new Date("2026-09-09T10:00:00.000Z");

describe("delete, restore, and cleanup lifecycle", () => {
  it("allows the safe active → trash → active recovery path", () => {
    expect(canTransitionFileStatus("active", "trash")).toBe(true);
    expect(canTransitionFileStatus("trash", "active")).toBe(true);
    expect(canTransitionFileStatus("deleted", "active")).toBe(false);
  });
  it("requires a transient deletion state before permanent deletion", () => {
    expect(canTransitionFileStatus("trash", "deleting")).toBe(true);
    expect(canTransitionFileStatus("deleting", "deleted")).toBe(true);
    expect(canTransitionFileStatus("active", "deleted")).toBe(false);
  });
  it("selects only expired automatic retention records", () => {
    expect(isDueForAutomaticCleanup({ status: "active", autoDeleteEnabled: true, deleteAt: new Date("2026-09-08T10:00:00Z") }, now)).toBe(true);
    expect(isDueForAutomaticCleanup({ status: "active", autoDeleteEnabled: true, deleteAt: new Date("2026-09-10T10:00:00Z") }, now)).toBe(false);
    expect(isDueForAutomaticCleanup({ status: "active", autoDeleteEnabled: false, deleteAt: new Date("2026-09-08T10:00:00Z") }, now)).toBe(false);
  });
  it("handles trash expiry and stale uploads independently for retryable cleanup", () => {
    expect(isDueForTrashExpiry({ status: "trash", permanentDeleteAt: new Date("2026-09-09T09:00:00Z") }, now)).toBe(true);
    expect(isStaleUpload({ status: "uploading", uploadExpiresAt: new Date("2026-09-09T09:00:00Z") }, now)).toBe(true);
    expect(isStaleUpload({ status: "active", uploadExpiresAt: new Date("2026-09-09T09:00:00Z") }, now)).toBe(false);
  });
});
