import { FileManager } from "@/components/files/file-manager";
import { getSessionActorFromCookies } from "@/lib/auth/session";
import { can } from "@/lib/auth/authorization";

export const metadata = { title: "Files" };

export default async function FilesPage() {
  const actor = await getSessionActorFromCookies();
  return <FileManager canManage={actor ? can(actor.role, "manage_files") : false} />;
}
