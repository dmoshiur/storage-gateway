import { redirect } from "next/navigation";
import { AdminShell } from "@/components/shell/admin-shell";
import { getSessionActorFromCookies } from "@/lib/auth/session";

export default async function ProtectedLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Server-side session verification: prevents unauthenticated access and avoids dashboard flicker.
  // If session is invalid/expired, redirect to login. The client-side AdminShell still handles
  // session expiry events and role-based UI.
  try {
    const actor = await getSessionActorFromCookies();
    if (!actor) {
      redirect("/admin/login");
    }
  } catch (error) {
    // Only redirect for auth failures (401). Configuration errors (503) should surface as 503,
    // not as a silent redirect loop that looks like a login problem.
    const isAuthError = error instanceof Error && (error as { status?: number }).status === 401;
    const code = (error as { code?: string })?.code;
    const isUnauthenticated = code === "UNAUTHENTICATED" || code === "SESSION_EXPIRED" || code === "INVALID_ID_TOKEN";
    if (isAuthError || isUnauthenticated || error === null) {
      redirect("/admin/login");
    }
    // For 503 configuration errors, let the error boundary handle it so operator sees actionable message.
    throw error;
  }
  return <AdminShell>{children}</AdminShell>;
}
