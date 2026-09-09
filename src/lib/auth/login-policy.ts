import type { Role } from "@/types/auth";
import { isValidRole } from "@/lib/auth/authorization";

export interface IdentityClaims {
  email?: string | null;
  role?: unknown;
  roles?: unknown;
}

/** Custom claims are authoritative; ADMIN_EMAILS is a documented bootstrap fallback. */
export function resolveRoleFromIdentityClaims(claims: IdentityClaims, bootstrapAdmins: ReadonlySet<string>): Role {
  if (isValidRole(claims.role)) return claims.role;
  if (Array.isArray(claims.roles) && claims.roles.some((value) => value === "admin")) return "admin";
  if (claims.email && bootstrapAdmins.has(claims.email.toLowerCase())) return "admin";
  return "viewer";
}
