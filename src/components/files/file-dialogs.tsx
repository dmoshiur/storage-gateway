"use client";

import { useState } from "react";
import { AlertTriangle, LoaderCircle, RotateCcw, Trash2 } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { apiFetch, ClientApiError } from "@/lib/client/api";
import type { RetentionType, SerializedFile } from "@/types/file";
import { formatDate, retentionLabel } from "@/utils/format";

function errorText(error: unknown, fallback: string) {
  return error instanceof ClientApiError ? error.message : fallback;
}

export function EditFileDialog({ file, onClose, onSaved }: { file: SerializedFile | null; onClose: () => void; onSaved: () => void }) {
  if (!file) return null;
  return <EditFileDialogContents key={file.id} file={file} onClose={onClose} onSaved={onSaved} />;
}

function EditFileDialogContents({ file, onClose, onSaved }: { file: SerializedFile; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(file.title);
  const [description, setDescription] = useState(file.description);
  const [category, setCategory] = useState(file.category);
  const [tags, setTags] = useState(file.tags.join(", "));
  const [autoDeleteEnabled, setAutoDeleteEnabled] = useState(file.autoDeleteEnabled);
  const [retentionType, setRetentionType] = useState<RetentionType>(file.retentionType);
  const [customDeleteAt, setCustomDeleteAt] = useState(file.customDeleteAt?.slice(0, 10) ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/files/${file.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          title,
          description,
          category,
          tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean),
          retention: { autoDeleteEnabled, retentionType, customDeleteAt: retentionType === "custom_date" ? customDeleteAt || null : null },
        }),
      });
      onSaved();
      onClose();
    } catch (caught) {
      setError(errorText(caught, "Changes could not be saved."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={() => !busy && onClose()} title="Edit document details" labelledDescription={`Update the searchable details and retention policy for ${file.originalName}.`}>
      <form className="space-y-4" onSubmit={save}>
        {error && <Notice type="error">{error}</Notice>}
        <div><label className="field-label" htmlFor="edit-title">Title</label><input id="edit-title" className="field-input" value={title} maxLength={160} onChange={(event) => setTitle(event.target.value)} disabled={busy} /></div>
        <div className="grid gap-4 sm:grid-cols-2"><div><label className="field-label" htmlFor="edit-category">Category</label><input id="edit-category" className="field-input" value={category} maxLength={80} onChange={(event) => setCategory(event.target.value)} disabled={busy} /></div><div><label className="field-label" htmlFor="edit-tags">Tags</label><input id="edit-tags" className="field-input" value={tags} onChange={(event) => setTags(event.target.value)} disabled={busy} /></div></div>
        <div><label className="field-label" htmlFor="edit-description">Description</label><textarea id="edit-description" className="field-input min-h-20" value={description} maxLength={2000} onChange={(event) => setDescription(event.target.value)} disabled={busy} /></div>
        <fieldset className="rounded-xl border border-slate-200 p-4"><legend className="px-1 text-sm font-bold">Retention</legend><label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1 h-4 w-4 rounded border-slate-300 text-ngo-600" checked={autoDeleteEnabled} onChange={(event) => setAutoDeleteEnabled(event.target.checked)} disabled={busy} /><span><strong>Enable automatic deletion</strong><span className="block text-slate-600">Due documents are moved to Trash before permanent deletion.</span></span></label>{autoDeleteEnabled && <div className="mt-4 grid gap-4 sm:grid-cols-2"><div><label className="field-label" htmlFor="edit-retention">Delete after</label><select id="edit-retention" className="field-input" value={retentionType} onChange={(event) => setRetentionType(event.target.value as RetentionType)} disabled={busy}>{(["never", "30_days", "3_months", "6_months", "1_year", "custom_date"] as RetentionType[]).map((value) => <option key={value} value={value}>{retentionLabel(value)}</option>)}</select></div>{retentionType === "custom_date" && <div><label className="field-label" htmlFor="edit-custom-date">Custom date</label><input id="edit-custom-date" className="field-input" type="date" value={customDeleteAt} onChange={(event) => setCustomDeleteAt(event.target.value)} disabled={busy} /></div>}</div>}</fieldset>
        <div className="flex justify-end gap-3 border-t border-slate-100 pt-4"><Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" disabled={busy}>{busy && <LoaderCircle className="h-4 w-4 animate-spin" />}Save changes</Button></div>
      </form>
    </Dialog>
  );
}

export function MoveToTrashDialog({ file, onClose, onMoved }: { file: SerializedFile | null; onClose: () => void; onMoved: () => void }) {
  if (!file) return null;
  return <MoveToTrashDialogContents key={file.id} file={file} onClose={onClose} onMoved={onMoved} />;
}

function MoveToTrashDialogContents({ file, onClose, onMoved }: { file: SerializedFile; onClose: () => void; onMoved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function move() {
    setBusy(true);
    try { await apiFetch(`/api/files/${file.id}`, { method: "DELETE", body: JSON.stringify({ confirmation: "MOVE_TO_TRASH" }) }); onMoved(); onClose(); }
    catch (caught) { setError(errorText(caught, "The document could not be moved to Trash.")); setBusy(false); }
  }
  return <Dialog open onClose={() => !busy && onClose()} title="Move this document to Trash?" destructive labelledDescription="This file remains in private storage and can be restored until its scheduled permanent deletion."><div className="rounded-lg bg-slate-50 p-3 text-sm font-semibold text-ink-900">{file.originalName}</div>{error && <div className="mt-4"><Notice type="error">{error}</Notice></div>}<div className="mt-5 flex justify-end gap-3"><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button variant="danger" onClick={move} disabled={busy}>{busy && <LoaderCircle className="h-4 w-4 animate-spin" />}<Trash2 className="h-4 w-4" />Move to Trash</Button></div></Dialog>;
}

export function RestoreDialog({ file, onClose, onRestored }: { file: SerializedFile | null; onClose: () => void; onRestored: () => void }) {
  if (!file) return null;
  return <RestoreDialogContents key={file.id} file={file} onClose={onClose} onRestored={onRestored} />;
}

function RestoreDialogContents({ file, onClose, onRestored }: { file: SerializedFile; onClose: () => void; onRestored: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function restore() {
    setBusy(true);
    try { await apiFetch(`/api/files/${file.id}/restore`, { method: "POST", body: "{}" }); onRestored(); onClose(); }
    catch (caught) { setError(errorText(caught, "The document could not be restored.")); setBusy(false); }
  }
  return <Dialog open onClose={() => !busy && onClose()} title="Restore this document?" labelledDescription="The document will return to active storage. Its private object must still be available to complete this recovery."><div className="rounded-lg bg-slate-50 p-3 text-sm font-semibold text-ink-900">{file.originalName}</div>{file.permanentDeleteAt && <p className="mt-3 text-sm text-slate-600">Scheduled permanent deletion: {formatDate(file.permanentDeleteAt)}</p>}{error && <div className="mt-4"><Notice type="error">{error}</Notice></div>}<div className="mt-5 flex justify-end gap-3"><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={restore} disabled={busy}>{busy && <LoaderCircle className="h-4 w-4 animate-spin" />}<RotateCcw className="h-4 w-4" />Restore document</Button></div></Dialog>;
}

export function PermanentDeleteDialog({ file, onClose, onDeleted }: { file: SerializedFile | null; onClose: () => void; onDeleted: () => void }) {
  if (!file) return null;
  return <PermanentDeleteDialogContents key={file.id} file={file} onClose={onClose} onDeleted={onDeleted} />;
}

function PermanentDeleteDialogContents({ file, onClose, onDeleted }: { file: SerializedFile; onClose: () => void; onDeleted: () => void }) {
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function remove() {
    if (confirmation !== "DELETE") return;
    setBusy(true);
    try { await apiFetch(`/api/files/${file.id}/permanent-delete`, { method: "POST", body: JSON.stringify({ confirmation }) }); onDeleted(); onClose(); }
    catch (caught) { setError(errorText(caught, "The document could not be permanently deleted.")); setBusy(false); }
  }
  return <Dialog open onClose={() => !busy && onClose()} title="Permanently delete this document?" destructive labelledDescription="This action removes the private R2 object and cannot be undone. Type DELETE exactly to confirm on the server."><div className="rounded-lg bg-red-50 p-3 text-sm font-semibold text-red-950">{file.originalName}</div><label className="mt-4 block"><span className="field-label">Type DELETE to confirm</span><input className="field-input" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" disabled={busy} /></label>{error && <div className="mt-4"><Notice type="error">{error}</Notice></div>}<div className="mt-5 flex justify-end gap-3"><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button variant="danger" onClick={remove} disabled={busy || confirmation !== "DELETE"}>{busy && <LoaderCircle className="h-4 w-4 animate-spin" />}<AlertTriangle className="h-4 w-4" />Delete permanently</Button></div></Dialog>;
}
