import { redirect } from "next/navigation";
import { AdminShell } from "@/components/admin/admin-shell";
import { getSessionActorFromCookies } from "@/lib/auth/session";
import { can } from "@/lib/auth/authorization";

export default async function ProtectedAdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const actor = await getSessionActorFromCookies();
  if (!actor || !can(actor.role, "manage_files")) redirect("/admin/login");
  return <AdminShell actorEmail={actor.email}>{children}</AdminShell>;
}
