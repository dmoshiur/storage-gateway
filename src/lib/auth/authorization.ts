import type { Role } from "@/types/auth";

export type Capability =
  | "read_files"
  | "manage_files"
  | "permanent_delete"
  | "manage_settings"
  | "manage_users"
  | "manage_api"
  | "manage_webhooks"
  | "view_audit"
  | "view_security"
  | "run_cleanup";

/**
 * Central policy point; roles can expand without changing every route.
 *
 * | Feature          | Admin | Editor | Viewer |
 * |------------------|-------|--------|--------|
 * | View/preview     | ✓     | ✓      | ✓      |
 * | Download         | ✓     | ✓      | ✓      |
 * | Upload           | ✓     | ✓      | ✗      |
 * | Edit metadata    | ✓     | ✓      | ✗      |
 * | Retention        | ✓     | ✓      | ✗      |
 * | Trash / restore  | ✓     | ✓      | ✗      |
 * | Permanent delete | ✓     | ✗      | ✗      |
 * | Users            | ✓     | ✗      | ✗      |
 * | API keys         | ✓     | ✗      | ✗      |
 * | Settings         | ✓     | ✗      | ✗      |
 * | Audit logs       | ✓     | ✗      | ✗      |
 */
const permissions: Record<Role, ReadonlySet<Capability>> = {
  admin: new Set([
    "read_files",
    "manage_files",
    "permanent_delete",
    "manage_settings",
    "manage_users",
    "manage_api",
    "manage_webhooks",
    "view_audit",
    "view_security",
    "run_cleanup",
  ]),
  editor: new Set(["read_files", "manage_files"]),
  viewer: new Set(["read_files"]),
};

export function can(role: Role, capability: Capability): boolean {
  return permissions[role].has(capability);
}

export function isValidRole(value: unknown): value is Role {
  return value === "admin" || value === "editor" || value === "viewer";
}
