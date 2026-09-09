import { redirect } from "next/navigation";
import { SettingsForm } from "@/components/settings/settings-form";
import { getSessionActorFromCookies } from "@/lib/auth/session";
import { can } from "@/lib/auth/authorization";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const actor = await getSessionActorFromCookies();
  if (!actor || !can(actor.role, "manage_settings")) redirect("/admin/dashboard");
  return <SettingsForm />;
}
