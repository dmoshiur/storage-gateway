import type { Role } from "@/types/auth";
import { isValidRole } from "@/lib/auth/authorization";

export interface IdentityClaims {
  email?: string | null;
  role?: unknown;
  roles?: unknown;
}

/**
 * Resolves a user's role from Firebase custom claims, with bootstrap fallback.
 *
 * Priority:
 * 1. Custom claim `role` (authoritative, set via Admin SDK)
 * 2. Custom claim `roles` array containing "admin"
 * 3. ADMIN_EMAILS bootstrap list (case-insensitive)
 * 4. Default to "viewer" — every authenticated Firebase user can sign in,
 *    but with least privilege. Admins can promote via dashboard.
 *
 * This ensures that a newly created Firebase user can always log in,
 * even before an admin assigns a role, preventing "user created but cannot log in" issues.
 */
export function resolveRoleFromIdentityClaims(claims: IdentityClaims, bootstrapAdmins: ReadonlySet<string>): Role {
  // Direct role claim is authoritative.
  if (isValidRole(claims.role)) return claims.role;

  // Legacy roles array support.
  if (Array.isArray(claims.roles)) {
    if (claims.roles.some((value) => value === "admin")) return "admin";
    if (claims.roles.some((value) => value === "editor")) return "editor";
    if (claims.roles.some((value) => value === "viewer")) return "viewer";
  }

  // Bootstrap admin emails: if email is in ADMIN_EMAILS, grant admin.
  // This is a documented fallback for initial setup, but custom claims remain authoritative thereafter.
  if (claims.email) {
    const normalizedEmail = claims.email.trim().toLowerCase();
    if (bootstrapAdmins.has(normalizedEmail)) return "admin";
  }

  // Default to viewer: least privilege, but still allows login.
  // This prevents the "Firebase user created but cannot use site" problem.
  return "viewer";
}
