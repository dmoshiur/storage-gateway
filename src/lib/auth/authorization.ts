import type { Role } from "@/types/auth";

export type Capability = "read_files" | "manage_files" | "manage_settings" | "view_audit" | "run_cleanup";

/** Central policy point; roles can expand without changing every route. */
const permissions: Record<Role, ReadonlySet<Capability>> = {
  admin: new Set(["read_files", "manage_files", "manage_settings", "view_audit", "run_cleanup"]),
  editor: new Set(["read_files"]),
  viewer: new Set(["read_files"]),
};

export function can(role: Role, capability: Capability): boolean {
  return permissions[role].has(capability);
}

export function isValidRole(value: unknown): value is Role {
  return value === "admin" || value === "editor" || value === "viewer";
}
