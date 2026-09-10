"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArchiveRestore, Download, Eye, Heart, Link2, Pencil, Trash2 } from "lucide-react";
import { useConfirm, useSession, useToast } from "@/components/providers";
import { apiErrorOptions, apiFetch } from "@/lib/client/api";
import type { SerializedFile } from "@/types/file";
import { formatRetention } from "@/utils/format";

export type FileAction = "download" | "copyLink" | "favorite" | "trash" | "restore" | "destroy";

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

/**
 * File actions deliberately own their busy state. A download or metadata
 * mutation must not replace the table, lock the page, or disable a different
 * row. The ref is the synchronous double-submit guard; the Set in state is
 * only the visual projection of that guard.
 */
export function useFileActions(refresh: () => void) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const { session } = useSession();
  const router = useRouter();
  const canManage = session?.role === "admin" || session?.role === "editor";
  const canDestroy = session?.role === "admin";
  const busyRef = useRef<Set<string>>(new Set());
  const retryHandlersRef = useRef<Partial<Record<FileAction, (file: SerializedFile) => void>>>({});
  const [busyKeys, setBusyKeys] = useState<Set<string>>(() => new Set());

  const actionKey = useCallback((file: SerializedFile, action: FileAction) => `${file.id}:${action}`, []);

  const begin = useCallback((file: SerializedFile, action: FileAction): boolean => {
    const key = actionKey(file, action);
    if (busyRef.current.has(key)) return false;
    busyRef.current.add(key);
    setBusyKeys((current) => new Set(current).add(key));
    return true;
  }, [actionKey]);

  const finish = useCallback((file: SerializedFile, action: FileAction) => {
    const key = actionKey(file, action);
    busyRef.current.delete(key);
    setBusyKeys((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }, [actionKey]);

  const isBusy = useCallback((file: SerializedFile, action: FileAction) => busyKeys.has(actionKey(file, action)), [actionKey, busyKeys]);
  const invokeRetry = useCallback((action: FileAction, file: SerializedFile) => {
    retryHandlersRef.current[action]?.(file);
  }, []);

  const preview = useCallback((file: SerializedFile) => {
    router.push(`/admin/files?preview=${file.id}`);
  }, [router]);

  const download = useCallback(async (file: SerializedFile): Promise<boolean> => {
    if (!begin(file, "download")) return false;
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
      return true;
    } catch (error) {
      const opts = apiErrorOptions(error, "Download failed. Try again.");
      toast(opts.message, "error", { requestId: opts.requestId, retry: () => invokeRetry("download", file) });
      return false;
    } finally {
      finish(file, "download");
    }
  }, [begin, finish, invokeRetry, toast]);

  const copyLink = useCallback(async (file: SerializedFile): Promise<boolean> => {
    if (!begin(file, "copyLink")) return false;
    try {
      const data = await apiFetch<{ url: string; expiresAt: string }>(`/api/files/${file.id}/download?disposition=inline`);
      await navigator.clipboard.writeText(data.url);
      toast("Temporary link copied. It expires soon.");
      return true;
    } catch (error) {
      const opts = apiErrorOptions(error, "Could not create a temporary link. Try again.");
      toast(opts.message, "error", { requestId: opts.requestId, retry: () => invokeRetry("copyLink", file) });
      return false;
    } finally {
      finish(file, "copyLink");
    }
  }, [begin, finish, invokeRetry, toast]);

  const toggleFavorite = useCallback(async (file: SerializedFile): Promise<boolean> => {
    if (!begin(file, "favorite")) return false;
    try {
      await apiFetch(`/api/files/${file.id}/favorite`, {
        method: "POST",
        body: JSON.stringify({ isFavorite: !file.isFavorite }),
      });
      toast(file.isFavorite ? "Removed from favorites." : "Added to favorites.");
      refresh();
      return true;
    } catch (error) {
      const opts = apiErrorOptions(error, "Favorite status could not be updated. Try again.");
      toast(opts.message, "error", { requestId: opts.requestId, retry: () => invokeRetry("favorite", file) });
      return false;
    } finally {
      finish(file, "favorite");
    }
  }, [begin, finish, invokeRetry, refresh, toast]);

  const trash = useCallback(async (file: SerializedFile): Promise<boolean> => {
    if (!begin(file, "trash")) return false;
    try {
      const ok = await confirm({
        title: "Move to Trash",
        description: `“${displayName(file)}” will be moved to Trash. It stays recoverable until its Trash retention expires.`,
        confirmLabel: "Move to Trash",
      });
      if (!ok) return false;
      await apiFetch(`/api/files/${file.id}`, { method: "DELETE", body: JSON.stringify({ confirmation: "MOVE_TO_TRASH" }) });
      toast("File moved to Trash.");
      refresh();
      return true;
    } catch (error) {
      const opts = apiErrorOptions(error, "Move to Trash failed. Try again.");
      toast(opts.message, "error", { requestId: opts.requestId, retry: () => invokeRetry("trash", file) });
      return false;
    } finally {
      finish(file, "trash");
    }
  }, [begin, confirm, finish, invokeRetry, refresh, toast]);

  const restore = useCallback(async (file: SerializedFile): Promise<boolean> => {
    if (!begin(file, "restore")) return false;
    try {
      await apiFetch(`/api/files/${file.id}/restore`, { method: "POST" });
      toast("File restored.");
      refresh();
      return true;
    } catch (error) {
      const opts = apiErrorOptions(error, "Restore failed. Try again.");
      toast(opts.message, "error", { requestId: opts.requestId, retry: () => invokeRetry("restore", file) });
      return false;
    } finally {
      finish(file, "restore");
    }
  }, [begin, finish, invokeRetry, refresh, toast]);

  const destroy = useCallback(async (file: SerializedFile): Promise<boolean> => {
    if (!begin(file, "destroy")) return false;
    try {
      const ok = await confirm({
        title: "Delete permanently?",
        description: `“${displayName(file)}” and its private stored bytes will be permanently deleted. This action cannot be undone.`,
        confirmLabel: "Delete permanently",
        tone: "danger",
        requireText: "DELETE",
      });
      if (!ok) return false;
      if (file.status === "active") {
        await apiFetch(`/api/files/${file.id}`, { method: "DELETE", body: JSON.stringify({ confirmation: "MOVE_TO_TRASH" }) });
      }
      await apiFetch(`/api/files/${file.id}/permanent-delete`, { method: "POST", body: JSON.stringify({ confirmation: "DELETE" }) });
      toast("File permanently deleted.");
      refresh();
      return true;
    } catch (error) {
      const opts = apiErrorOptions(error, "Permanent deletion failed. Try again.");
      toast(opts.message, "error", { requestId: opts.requestId, retry: () => invokeRetry("destroy", file) });
      return false;
    } finally {
      finish(file, "destroy");
    }
  }, [begin, confirm, finish, invokeRetry, refresh, toast]);

  useEffect(() => {
    retryHandlersRef.current = {
      download: (file) => { void download(file); },
      copyLink: (file) => { void copyLink(file); },
      favorite: (file) => { void toggleFavorite(file); },
      trash: (file) => { void trash(file); },
      restore: (file) => { void restore(file); },
      destroy: (file) => { void destroy(file); },
    };
    return () => { retryHandlersRef.current = {}; };
  }, [copyLink, download, destroy, restore, toggleFavorite, trash]);

  return {
    preview,
    download,
    copyLink,
    toggleFavorite,
    trash,
    restore,
    destroy,
    isBusy,
    canManage,
    canDestroy,
  };
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
