import { redirect } from "next/navigation";
import { AuditLogList } from "@/components/audit/audit-log-list";
import { getSessionActorFromCookies } from "@/lib/auth/session";
import { can } from "@/lib/auth/authorization";

export const metadata = { title: "Audit logs" };

export default async function AuditLogsPage() {
  const actor = await getSessionActorFromCookies();
  if (!actor || !can(actor.role, "view_audit")) redirect("/admin/dashboard");
  return <AuditLogList />;
}
