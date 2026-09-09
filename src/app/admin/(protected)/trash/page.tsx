import { FileManager } from "@/components/files/file-manager";
import { getSessionActorFromCookies } from "@/lib/auth/session";
import { can } from "@/lib/auth/authorization";

export const metadata = { title: "Trash" };

export default async function TrashPage() {
  const actor = await getSessionActorFromCookies();
  return <FileManager trash canManage={actor ? can(actor.role, "manage_files") : false} />;
}
