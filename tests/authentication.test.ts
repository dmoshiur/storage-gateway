import { describe, expect, it } from "vitest";
import { can } from "@/lib/auth/authorization";
import { resolveRoleFromIdentityClaims, shouldCreateAdminSession } from "@/lib/auth/login-policy";

describe("authentication and authorization policy", () => {
  const administrators = new Set(["admin@ngo.example"]);
  it("permits an authorized login through a custom claim or configured bootstrap admin", () => {
    expect(resolveRoleFromIdentityClaims({ email: "staff@ngo.example", role: "admin" }, administrators)).toBe("admin");
    expect(shouldCreateAdminSession({ email: "ADMIN@ngo.example" }, administrators)).toBe(true);
  });
  it("rejects an unauthorized account from the admin session", () => {
    expect(shouldCreateAdminSession({ email: "visitor@ngo.example" }, administrators)).toBe(false);
    expect(can("viewer", "manage_files")).toBe(false);
  });
  it("keeps logout/session capabilities separate from role escalation", () => {
    expect(can("admin", "manage_files")).toBe(true);
    expect(can("editor", "read_files")).toBe(true);
    expect(can("editor", "manage_settings")).toBe(false);
  });
});
