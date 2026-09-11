import { describe, expect, it } from "vitest";
import { can } from "@/lib/auth/authorization";

describe("role permissions", () => {
  it("keeps viewers read-only and editors away from administration", () => {
    expect(can("viewer", "read_files")).toBe(true);
    expect(can("viewer", "manage_files")).toBe(false);
    expect(can("editor", "manage_files")).toBe(true);
    expect(can("editor", "manage_users")).toBe(false);
    expect(can("admin", "manage_users")).toBe(true);
  });
});
