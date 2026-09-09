import { ApiManagement } from "@/components/settings/api-management";
import { getSessionActorFromCookies } from "@/lib/auth/session";
import { can } from "@/lib/auth/authorization";
import { redirect } from "next/navigation";
export const metadata = { title: "API Management" };
export default async function Page() { const actor = await getSessionActorFromCookies(); if (!actor || !can(actor.role, "manage_settings")) redirect("/admin/dashboard"); return <ApiManagement />; }
