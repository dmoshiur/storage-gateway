"use client";

import { useState } from "react";
import { FolderOpen, Pencil, Plus, Trash2 } from "lucide-react";
import { useConfirm, useSession, useToast } from "@/components/providers";
import { useQuery } from "@/hooks/use-query";
import { Dialog } from "@/components/ui/overlays";
import { EmptyState, ErrorState, Spinner, TableSkeleton } from "@/components/ui/feedback";
import { apiFetch, ClientApiError } from "@/lib/client/api";
import type { SerializedCategory } from "@/types/category";

const COLORS = ["slate", "red", "orange", "amber", "green", "blue", "purple", "pink"];

const COLOR_HEX: Record<string, string> = {
  slate: "#64748b",
  red: "#ef4444",
  orange: "#f97316",
  amber: "#f59e0b",
  green: "#10b981",
  blue: "#3b82f6",
  purple: "#8b5cf6",
  pink: "#ec4899",
};

export default function CategoriesPage() {
  const { session } = useSession();
  const { toast } = useToast();
  const confirm = useConfirm();
  const { data, error, loading, refresh } = useQuery<{ categories: SerializedCategory[] }>("/api/categories");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<SerializedCategory | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState("slate");
  const [busy, setBusy] = useState(false);

  const canManage = session?.role !== "viewer";

  const startCreate = () => {
    setEditing(null);
    setName("");
    setDescription("");
    setColor("slate");
    setOpen(true);
  };

  const startEdit = (category: SerializedCategory) => {
    setEditing(category);
    setName(category.name);
    setDescription(category.description ?? "");
    setColor(category.color ?? "slate");
    setOpen(true);
  };

  const save = async () => {
    setBusy(true);
    try {
      if (editing) {
        await apiFetch(`/api/categories/${editing.id}`, {
          method: "PATCH",
          body: JSON.stringify({ name: name.trim(), description: description.trim(), color }),
        });
        toast("Category updated.");
      } else {
        await apiFetch("/api/categories", {
          method: "POST",
          body: JSON.stringify({ name: name.trim(), description: description.trim() || undefined, color }),
        });
        toast("Category created.");
      }
      setOpen(false);
      refresh();
    } catch (saveError) {
      toast(saveError instanceof ClientApiError ? saveError.message : "Save failed.", "error");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (category: SerializedCategory) => {
    const ok = await confirm({
      title: `Delete “${category.name}”?`,
      description: `Files in this category (${category.fileCount}) keep working but lose the category assignment.`,
      confirmLabel: "Delete category",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await apiFetch(`/api/categories/${category.id}`, { method: "DELETE" });
      toast("Category deleted.");
      refresh();
    } catch (deleteError) {
      toast(deleteError instanceof ClientApiError ? deleteError.message : "Deletion failed.", "error");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">Categories</h1>
          <p className="page-sub">Organize documents into collections for browsing and filtering.</p>
        </div>
        {canManage && (
          <button type="button" className="btn-primary btn-sm" onClick={startCreate}>
            <Plus className="h-4 w-4" /> New category
          </button>
        )}
      </div>

      {loading && <TableSkeleton rows={4} columns={3} />}
      {error && !loading && <div className="tbl-wrap"><ErrorState message={error} onRetry={refresh} /></div>}
      {!loading && !error && (data?.categories.length ?? 0) === 0 && (
        <div className="tbl-wrap">
          <EmptyState
            icon={<FolderOpen className="h-6 w-6" />}
            title="No categories yet"
            description="Create categories like Finance, Programs, or Grants to organize documents."
            action={canManage ? <button type="button" className="btn-primary btn-sm" onClick={startCreate}><Plus className="h-4 w-4" /> New category</button> : undefined}
          />
        </div>
      )}
      {!loading && !error && (data?.categories.length ?? 0) > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {data!.categories.map((category) => (
            <div key={category.id} className="card-pad">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="dot-md" aria-hidden="true" style={{ backgroundColor: COLOR_HEX[category.color ?? "slate"] ?? COLOR_HEX.slate }} />
                    <h3 className="truncate text-[15px] font-semibold text-ink">{category.name}</h3>
                  </div>
                  {category.description && <p className="mt-1 line-clamp-2 text-[13px] text-ink-muted">{category.description}</p>}
                  <p className="tnum mt-1.5 text-xs text-ink-faint">{category.fileCount} files</p>
                </div>
                {canManage && (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button type="button" className="icon-btn" aria-label={`Edit ${category.name}`} onClick={() => startEdit(category)}>
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button type="button" className="icon-btn-danger" aria-label={`Delete ${category.name}`} onClick={() => remove(category)}>
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {open && (
        <Dialog title={editing ? "Edit category" : "New category"} onClose={() => setOpen(false)}>
          <div className="space-y-4">
            <div>
              <label className="field-label" htmlFor="cat-name">Name</label>
              <input id="cat-name" className="field-input" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="e.g. Finance" />
            </div>
            <div>
              <label className="field-label" htmlFor="cat-desc">Description (optional)</label>
              <input id="cat-desc" className="field-input" value={description} maxLength={200} onChange={(event) => setDescription(event.target.value)} placeholder="What belongs here?" />
            </div>
            <div>
              <span className="field-label">Color</span>
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Category color">
                {COLORS.map((candidate) => (
                  <button
                    key={candidate}
                    type="button"
                    role="radio"
                    aria-checked={color === candidate}
                    aria-label={candidate}
                    onClick={() => setColor(candidate)}
                    className={`h-7 w-7 rounded-full border-2 transition-transform ${color === candidate ? "scale-110 border-slate-900 dark:border-white" : "border-transparent"}`}
                    style={{ backgroundColor: COLOR_HEX[candidate] }}
                  />
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2.5">
              <button type="button" className="btn-secondary" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
              <button type="button" className="btn-primary" onClick={save} disabled={busy || !name.trim()}>
                {busy && <Spinner />} {editing ? "Save changes" : "Create category"}
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}
