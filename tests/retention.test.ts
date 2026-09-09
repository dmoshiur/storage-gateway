import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/errors";
import { calculateDeleteAt } from "@/lib/retention";

describe("retention calculation", () => {
  const now = new Date("2026-01-31T10:00:00.000Z");
  it("calculates a 30-day policy on the server", () => {
    expect(calculateDeleteAt({ autoDeleteEnabled: true, retentionType: "30_days" }, now)?.toISOString()).toBe("2026-03-02T10:00:00.000Z");
  });
  it("clamps three calendar months correctly", () => {
    expect(calculateDeleteAt({ autoDeleteEnabled: true, retentionType: "3_months" }, now)?.toISOString()).toBe("2026-04-30T10:00:00.000Z");
  });
  it("calculates six months and one year", () => {
    expect(calculateDeleteAt({ autoDeleteEnabled: true, retentionType: "6_months" }, now)?.toISOString()).toBe("2026-07-31T10:00:00.000Z");
    expect(calculateDeleteAt({ autoDeleteEnabled: true, retentionType: "1_year" }, now)?.toISOString()).toBe("2027-01-31T10:00:00.000Z");
  });
  it("supports a future custom date and rejects an expired one", () => {
    expect(calculateDeleteAt({ autoDeleteEnabled: true, retentionType: "custom_date", customDeleteAt: "2026-02-14" }, now)?.toISOString()).toBe("2026-02-14T23:59:59.999Z");
    expect(() => calculateDeleteAt({ autoDeleteEnabled: true, retentionType: "custom_date", customDeleteAt: "2026-01-01" }, now)).toThrow(ApiError);
  });
  it("never computes a date for disabled or Never policies", () => {
    expect(calculateDeleteAt({ autoDeleteEnabled: false, retentionType: "6_months" }, now)).toBeNull();
    expect(calculateDeleteAt({ autoDeleteEnabled: true, retentionType: "never" }, now)).toBeNull();
  });
});
