import { describe, expect, it } from "vitest";
import { can } from "@/lib/auth/authorization";
import { resolveRoleFromIdentityClaims } from "@/lib/auth/login-policy";

describe("authentication and authorization policy", () => {
  const administrators = new Set(["admin@ngo.example"]);
  it("resolves an administrator through a custom claim or configured bootstrap admin", () => {
    expect(resolveRoleFromIdentityClaims({ email: "staff@ngo.example", role: "admin" }, administrators)).toBe("admin");
    expect(resolveRoleFromIdentityClaims({ email: "ADMIN@ngo.example" }, administrators)).toBe("admin");
  });
  it("lets any provisioned Firebase account sign in with at least read-only access", () => {
    // Every user created in Firebase Authentication defaults to the viewer role,
    // which can browse and download but never mutate storage.
    expect(resolveRoleFromIdentityClaims({ email: "visitor@ngo.example" }, administrators)).toBe("viewer");
    expect(can("viewer", "read_files")).toBe(true);
    expect(can("viewer", "manage_files")).toBe(false);
    expect(can("viewer", "manage_settings")).toBe(false);
  });
  it("keeps role capabilities centralized and separate from sign-in", () => {
    expect(can("admin", "manage_files")).toBe(true);
    expect(can("admin", "permanent_delete")).toBe(true);
    expect(can("admin", "manage_users")).toBe(true);
    expect(can("admin", "manage_api")).toBe(true);
    expect(can("admin", "manage_webhooks")).toBe(true);
    expect(can("admin", "view_audit")).toBe(true);
    expect(can("editor", "read_files")).toBe(true);
    // Editors manage the document lifecycle but never destroy or administer.
    expect(can("editor", "manage_files")).toBe(true);
    expect(can("editor", "permanent_delete")).toBe(false);
    expect(can("editor", "manage_settings")).toBe(false);
    expect(can("editor", "manage_users")).toBe(false);
    expect(can("editor", "manage_api")).toBe(false);
    expect(can("viewer", "manage_files")).toBe(false);
    expect(can("viewer", "view_audit")).toBe(false);
  });
});
