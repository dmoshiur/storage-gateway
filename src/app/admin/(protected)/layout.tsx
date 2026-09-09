import { redirect } from "next/navigation";
import { AdminShell } from "@/components/admin/admin-shell";
import { getSessionActorFromCookies } from "@/lib/auth/session";
import { can } from "@/lib/auth/authorization";

export default async function ProtectedAdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const actor = await getSessionActorFromCookies();
  // Any signed-in actor (shared pass or provisioned Firebase user) may enter;
  // each page and API route still enforces its own capability.
  if (!actor || !can(actor.role, "read_files")) redirect("/admin/login");
  return <AdminShell actorEmail={actor.email} actorRole={actor.role}>{children}</AdminShell>;
}
