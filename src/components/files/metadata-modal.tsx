"use client";

import { useRef, useState } from "react";
import { useToast } from "@/components/providers";
import { Dialog } from "@/components/ui/overlays";
import { Spinner } from "@/components/ui/feedback";
import { apiErrorOptions, apiFetch } from "@/lib/client/api";
import type { SerializedFile } from "@/types/file";
import type { RetentionType } from "@/types/file";

export const RETENTION_OPTIONS: { value: RetentionType; label: string }[] = [
  { value: "never", label: "Never delete" },
  { value: "30_days", label: "30 days" },
  { value: "3_months", label: "3 months" },
  { value: "6_months", label: "6 months" },
  { value: "1_year", label: "1 year" },
  { value: "custom_date", label: "Custom date" },
];

export function MetadataModal({
  file,
  categories,
  onClose,
  onSaved,
}: {
  file: SerializedFile;
  categories: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [title, setTitle] = useState(file.title);
  const [description, setDescription] = useState(file.description);
  const [category, setCategory] = useState(file.category);
  const [tags, setTags] = useState(file.tags.join(", "));
  const [autoDelete, setAutoDelete] = useState(file.autoDeleteEnabled);
  const [retentionType, setRetentionType] = useState<RetentionType>(file.retentionType);
  const [customDate, setCustomDate] = useState(file.customDeleteAt ? file.customDeleteAt.slice(0, 10) : "");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const tagList = tags.split(",").map((tag) => tag.trim().toLowerCase().replace(/\s+/g, " ")).filter(Boolean).slice(0, 20);
      await apiFetch(`/api/files/${file.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim(),
          category: category.trim(),
          tags: tagList,
          retention: {
            autoDeleteEnabled: autoDelete,
            retentionType: autoDelete ? retentionType : "never",
            customDeleteAt: autoDelete && retentionType === "custom_date" ? customDate || null : null,
          },
        }),
      });
      toast("Metadata updated.");
      onSaved();
    } catch (saveError) {
      setError(apiErrorOptions(saveError, "Update failed. Try again.").message);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <Dialog title="Edit metadata" description={file.originalName} onClose={onClose} wide dismissable={!saving}>
      <div className="space-y-4">
        <div>
          <label className="field-label" htmlFor="meta-title">Display title</label>
          <input id="meta-title" className="field-input" value={title} maxLength={160} onChange={(event) => setTitle(event.target.value)} />
          <p className="field-hint">Renaming the display title never changes the stored object.</p>
        </div>
        <div>
          <label className="field-label" htmlFor="meta-desc">Description</label>
          <textarea id="meta-desc" className="field-input min-h-[76px]" value={description} maxLength={2000} onChange={(event) => setDescription(event.target.value)} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="field-label" htmlFor="meta-cat">Category</label>
            <input id="meta-cat" className="field-input" list="nfc-categories" value={category} maxLength={80} onChange={(event) => setCategory(event.target.value)} />
            <datalist id="nfc-categories">
              {categories.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </div>
          <div>
            <label className="field-label" htmlFor="meta-tags">Tags (comma-separated)</label>
            <input id="meta-tags" className="field-input mono" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="annual, report, finance" />
          </div>
        </div>
        <div className="rounded-lg border border-line bg-surface-sunken p-4">
          <label className="flex cursor-pointer items-center justify-between gap-3">
            <span>
              <span className="block text-sm font-medium text-ink">Automatic deletion</span>
              <span className="block text-xs text-ink-muted">Move to Trash automatically when retention expires.</span>
            </span>
            <input type="checkbox" className="field-check h-5 w-5" checked={autoDelete} onChange={(event) => setAutoDelete(event.target.checked)} />
          </label>
          {autoDelete && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <label className="field-label" htmlFor="meta-ret">Retention</label>
                <select id="meta-ret" className="field-input" value={retentionType} onChange={(event) => setRetentionType(event.target.value as RetentionType)}>
                  {RETENTION_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>
              {retentionType === "custom_date" && (
                <div>
                  <label className="field-label" htmlFor="meta-date">Delete on</label>
                  <input id="meta-date" type="date" className="field-input" value={customDate} onChange={(event) => setCustomDate(event.target.value)} />
                </div>
              )}
            </div>
          )}
        </div>
        {error && (
          <div role="alert" className="flex items-center justify-between gap-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
            <span>{error}</span>
            <button type="button" className="btn-ghost btn-sm shrink-0" onClick={() => void save()}>Retry</button>
          </div>
        )}
        <div className="flex justify-end gap-2.5">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving} aria-busy={saving}>
            {saving && <Spinner />} {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
