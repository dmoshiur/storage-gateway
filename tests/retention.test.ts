import { describe, expect, it } from "vitest";
import { calculateDeleteAt } from "@/lib/retention";

describe("retention rules", () => {
  const now = new Date("2026-01-01T12:00:00.000Z");
  it("does not schedule files marked never", () => {
    expect(calculateDeleteAt({ autoDeleteEnabled: false, retentionType: "never", customDeleteAt: null }, now)).toBeNull();
  });
  it("calculates a real future deletion date", () => {
    expect(calculateDeleteAt({ autoDeleteEnabled: true, retentionType: "30_days", customDeleteAt: null }, now)?.toISOString()).toBe("2026-01-31T12:00:00.000Z");
  });
});
