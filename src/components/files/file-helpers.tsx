"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { ArchiveRestore, Download, Eye, Heart, Link2, Pencil, Trash2 } from "lucide-react";
import { useConfirm, useSession, useToast } from "@/components/providers";
import { apiFetch, ClientApiError } from "@/lib/client/api";
import type { SerializedFile } from "@/types/file";
import { formatRetention } from "@/utils/format";

export function StatusBadge({ file }: { file: SerializedFile }) {
  const [now] = useState(() => Date.now());
  if (file.status === "trash") return <span className="badge-warning">Trash</span>;
  if (file.status === "deleting" || file.status === "uploading") return <span className="badge-info">Processing</span>;
  if (file.status === "failed") return <span className="badge-danger">Failed</span>;
  if (file.autoDeleteEnabled && file.deleteAt && new Date(file.deleteAt).getTime() <= now + 7 * 86400000) {
    return <span className="badge-warning">Expiring</span>;
  }
  return <span className="badge-success">Active</span>;
}

export function RetentionLabel({ file }: { file: SerializedFile }) {
  return <span className="whitespace-nowrap">{formatRetention(file.retentionType, file.autoDeleteEnabled)}</span>;
}

export function FileTypeIcon({ extension }: { extension: string }) {
  return (
    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-red-500/10 font-mono text-[10px] font-bold uppercase text-red-600 dark:text-red-400">
      {extension.slice(0, 4) || "PDF"}
    </span>
  );
}

export function displayName(file: SerializedFile): string {
  return file.title || file.originalName;
}

export function useFileActions(refresh: () => void) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const { session } = useSession();
  const router = useRouter();
  const canManage = session?.role === "admin" || session?.role === "editor";
  const canDestroy = session?.role === "admin";

  const preview = useCallback((file: SerializedFile) => {
    router.push(`/admin/files?preview=${file.id}`);
  }, [router]);

  const download = useCallback(async (file: SerializedFile) => {
    try {
      const data = await apiFetch<{ url: string }>(`/api/files/${file.id}/download`);
      const link = document.createElement("a");
      link.href = data.url;
      link.download = file.originalName;
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
      toast("Download started.");
    } catch (error) {
      toast(error instanceof ClientApiError ? error.message : "Download failed.", "error");
    }
  }, [toast]);

  const copyLink = useCallback(async (file: SerializedFile) => {
    try {
      const data = await apiFetch<{ url: string; expiresAt: string }>(`/api/files/${file.id}/download?disposition=inline`);
      await navigator.clipboard.writeText(data.url);
      toast("Temporary link copied. It expires soon.");
    } catch {
      toast("Could not create a temporary link.", "error");
    }
  }, [toast]);

  const toggleFavorite = useCallback(async (file: SerializedFile) => {
    try {
      await apiFetch(`/api/files/${file.id}/favorite`, {
        method: "POST",
        body: JSON.stringify({ isFavorite: !file.isFavorite }),
      });
      toast(file.isFavorite ? "Removed from favorites." : "Added to favorites.");
      refresh();
    } catch (error) {
      toast(error instanceof ClientApiError ? error.message : "Update failed.", "error");
    }
  }, [toast, refresh]);

  const trash = useCallback(async (file: SerializedFile) => {
    const ok = await confirm({
      title: "Move to Trash",
      description: `“${displayName(file)}” will be moved to Trash. It stays recoverable until its Trash retention expires.`,
      confirmLabel: "Move to Trash",
    });
    if (!ok) return;
    try {
      await apiFetch(`/api/files/${file.id}`, { method: "DELETE", body: JSON.stringify({ confirmation: "MOVE_TO_TRASH" }) });
      toast("File moved to Trash.");
      refresh();
    } catch (error) {
      toast(error instanceof ClientApiError ? error.message : "Move to Trash failed.", "error");
    }
  }, [confirm, toast, refresh]);

  const restore = useCallback(async (file: SerializedFile) => {
    try {
      await apiFetch(`/api/files/${file.id}/restore`, { method: "POST" });
      toast("File restored.");
      refresh();
    } catch (error) {
      toast(error instanceof ClientApiError ? error.message : "Restore failed.", "error");
    }
  }, [toast, refresh]);

  const destroy = useCallback(async (file: SerializedFile) => {
    const ok = await confirm({
      title: "Delete permanently?",
      description: `“${displayName(file)}” and its private stored bytes will be permanently deleted. This action cannot be undone.`,
      confirmLabel: "Delete permanently",
      tone: "danger",
      requireText: "DELETE",
    });
    if (!ok) return;
    try {
      if (file.status === "active") {
        await apiFetch(`/api/files/${file.id}`, { method: "DELETE", body: JSON.stringify({ confirmation: "MOVE_TO_TRASH" }) });
      }
      await apiFetch(`/api/files/${file.id}/permanent-delete`, { method: "POST", body: JSON.stringify({ confirmation: "DELETE" }) });
      toast("File permanently deleted.");
      refresh();
    } catch (error) {
      toast(error instanceof ClientApiError ? error.message : "Permanent deletion failed.", "error");
    }
  }, [confirm, toast, refresh]);

  return { preview, download, copyLink, toggleFavorite, trash, restore, destroy, canManage, canDestroy };
}

export const FILE_ACTION_ICONS = {
  preview: Eye,
  download: Download,
  copyLink: Link2,
  favorite: Heart,
  edit: Pencil,
  trash: Trash2,
  restore: ArchiveRestore,
};
