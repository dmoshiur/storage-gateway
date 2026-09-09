"use client";

import { useState } from "react";
import { Download, Edit3, Eye, FileText, LoaderCircle, RotateCcw, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice } from "@/components/ui/notice";
import { apiFetch, ClientApiError } from "@/lib/client/api";
import type { SerializedFile } from "@/types/file";
import { formatBytes, formatDate, retentionLabel } from "@/utils/format";

export function FileTable({ files, trash = false, loading, onEdit, onTrash, onRestore, onPermanentDelete }: {
  files: SerializedFile[];
  trash?: boolean;
  loading?: boolean;
  onEdit: (file: SerializedFile) => void;
  onTrash: (file: SerializedFile) => void;
  onRestore: (file: SerializedFile) => void;
  onPermanentDelete: (file: SerializedFile) => void;
}) {
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  async function open(file: SerializedFile, disposition: "inline" | "attachment") {
    if (openingId) return;
    // Opening a blank tab synchronously preserves the user gesture; it is filled only after authorization succeeds.
    const target = window.open("", "_blank");
    if (target) {
      target.opener = null;
      target.document.title = "Preparing private PDF…";
    }
    setOpeningId(file.id);
    setDownloadError(null);
    try {
      const { url } = await apiFetch<{ url: string }>(`/api/files/${file.id}/download?disposition=${disposition}`);
      if (target && !target.closed) target.location.replace(url);
      else window.open(`/api/files/${file.id}/download?disposition=${disposition}&redirect=true`, "_blank", "noopener");
    } catch (caught) {
      target?.close();
      setDownloadError(caught instanceof ClientApiError ? caught.message : "A temporary PDF link could not be generated. Please try again.");
    } finally {
      setOpeningId(null);
    }
  }

  if (!loading && files.length === 0) return <EmptyState icon={trash ? Trash2 : FileText} title={trash ? "Trash is empty" : "No matching PDFs"} detail={trash ? "Files moved to Trash can be restored here until their scheduled permanent deletion." : "Try changing the filters or upload a new PDF."} />;

  return <>
    {downloadError && <div className="mb-4"><Notice type="error">{downloadError}</Notice></div>}
    <div className="hidden overflow-x-auto rounded-xl border border-slate-200 md:block">
      <table className="min-w-full divide-y divide-slate-200">
        <thead className="bg-slate-50"><tr><th className="table-heading px-4 py-3">PDF</th><th className="table-heading px-4 py-3">Category</th><th className="table-heading px-4 py-3">Size</th><th className="table-heading px-4 py-3">{trash ? "Deleted" : "Uploaded"}</th>{trash && <th className="table-heading px-4 py-3">Reason</th>}<th className="table-heading px-4 py-3">{trash ? "Permanent deletion" : "Delete date"}</th><th className="table-heading px-4 py-3">Status</th><th className="table-heading px-4 py-3"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody className="divide-y divide-slate-100 bg-white">{files.map((file) => <tr key={file.id} className="align-top hover:bg-slate-50"><td className="max-w-xs px-4 py-4"><FileIdentity file={file} /></td><td className="px-4 py-4 text-sm text-slate-600">{file.category || "—"}</td><td className="whitespace-nowrap px-4 py-4 text-sm text-slate-600">{formatBytes(file.size)}</td><td className="whitespace-nowrap px-4 py-4 text-sm text-slate-600">{formatDate(trash ? file.deletedAt : file.createdAt)}</td>{trash && <td className="px-4 py-4 text-sm text-slate-600">{deletionReasonLabel(file.deletionReason)}</td>}<td className="whitespace-nowrap px-4 py-4 text-sm text-slate-600">{trash ? formatDate(file.permanentDeleteAt) : file.autoDeleteEnabled ? formatDate(file.deleteAt) : "Never"}</td><td className="px-4 py-4"><Badge status={file.status}>{file.status === "active" ? (file.autoDeleteEnabled ? `Active · ${retentionLabel(file.retentionType)}` : "Active") : file.status}</Badge></td><td className="px-4 py-3"><DesktopActions file={file} trash={trash} opening={openingId === file.id} onOpen={open} onEdit={onEdit} onTrash={onTrash} onRestore={onRestore} onPermanentDelete={onPermanentDelete} /></td></tr>)}</tbody>
      </table>
    </div>
    <div className="space-y-3 md:hidden">{files.map((file) => <article key={file.id} className="rounded-xl border border-slate-200 bg-white p-4"><div className="flex gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-red-50 text-red-700"><FileText className="h-4 w-4" /></span><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold text-ink-900">{file.title || file.originalName}</p><p className="mt-0.5 truncate text-xs text-slate-500">{file.originalName}</p><div className="mt-2"><Badge status={file.status}>{file.status === "active" ? "Active" : file.status}</Badge></div></div></div><dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-3 text-sm"><div><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Category</dt><dd className="mt-0.5 text-slate-700">{file.category || "—"}</dd></div><div><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Size</dt><dd className="mt-0.5 text-slate-700">{formatBytes(file.size)}</dd></div><div><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{trash ? "Delete on" : "Retention"}</dt><dd className="mt-0.5 text-slate-700">{trash ? formatDate(file.permanentDeleteAt) : file.autoDeleteEnabled ? formatDate(file.deleteAt) : "Never"}</dd></div><div><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{trash ? "Deleted" : "Uploaded"}</dt><dd className="mt-0.5 text-slate-700">{formatDate(trash ? file.deletedAt : file.createdAt)}</dd></div>{trash && <div><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Reason</dt><dd className="mt-0.5 text-slate-700">{deletionReasonLabel(file.deletionReason)}</dd></div>}</dl><div className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-3"><MobileActions file={file} trash={trash} opening={openingId === file.id} onOpen={open} onEdit={onEdit} onTrash={onTrash} onRestore={onRestore} onPermanentDelete={onPermanentDelete} /></div></article>)}</div>
  </>;
}

function FileIdentity({ file }: { file: SerializedFile }) {
  return <div className="flex gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-red-50 text-red-700"><FileText className="h-4 w-4" /></span><div className="min-w-0"><p className="truncate text-sm font-bold text-ink-900" title={file.title || file.originalName}>{file.title || file.originalName}</p><p className="mt-0.5 truncate text-xs text-slate-500" title={file.originalName}>{file.originalName}</p>{file.tags.length > 0 && <p className="mt-1 truncate text-xs text-slate-500">{file.tags.join(", ")}</p>}</div></div>;
}

interface ActionProps { file: SerializedFile; trash: boolean; opening: boolean; onOpen: (file: SerializedFile, disposition: "inline" | "attachment") => void; onEdit: (file: SerializedFile) => void; onTrash: (file: SerializedFile) => void; onRestore: (file: SerializedFile) => void; onPermanentDelete: (file: SerializedFile) => void; }
function DesktopActions({ file, trash, opening, onOpen, onEdit, onTrash, onRestore, onPermanentDelete }: ActionProps) {
  return <div className="flex justify-end gap-1">{trash ? <><IconButton label={`Restore ${file.originalName}`} onClick={() => onRestore(file)}><RotateCcw className="h-4 w-4" /></IconButton><IconButton label={`Permanently delete ${file.originalName}`} danger onClick={() => onPermanentDelete(file)}><Trash2 className="h-4 w-4" /></IconButton></> : <><IconButton label={`View ${file.originalName}`} disabled={opening} onClick={() => void onOpen(file, "inline")}>{opening ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}</IconButton><IconButton label={`Download ${file.originalName}`} disabled={opening} onClick={() => void onOpen(file, "attachment")}><Download className="h-4 w-4" /></IconButton><IconButton label={`Edit ${file.originalName}`} onClick={() => onEdit(file)}><Edit3 className="h-4 w-4" /></IconButton><IconButton label={`Move ${file.originalName} to Trash`} danger onClick={() => onTrash(file)}><Trash2 className="h-4 w-4" /></IconButton></>}</div>;
}
function MobileActions({ file, trash, opening, onOpen, onEdit, onTrash, onRestore, onPermanentDelete }: ActionProps) {
  return trash ? <><Button variant="secondary" className="flex-1" onClick={() => onRestore(file)}><RotateCcw className="h-4 w-4" />Restore</Button><Button variant="danger" className="flex-1" onClick={() => onPermanentDelete(file)}><Trash2 className="h-4 w-4" />Delete</Button></> : <><Button variant="secondary" disabled={opening} onClick={() => void onOpen(file, "inline")}>{opening ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}View</Button><Button variant="secondary" disabled={opening} onClick={() => void onOpen(file, "attachment")}><Download className="h-4 w-4" />Download</Button><Button variant="secondary" onClick={() => onEdit(file)}><Edit3 className="h-4 w-4" />Edit</Button><Button variant="danger" onClick={() => onTrash(file)}><Trash2 className="h-4 w-4" />Trash</Button></>;
}
function deletionReasonLabel(reason: SerializedFile["deletionReason"]): string { if (reason === "auto_retention") return "Automatic retention"; if (reason === "manual") return "Manual action"; if (reason === "cleanup") return "Cleanup"; return "—"; }
function IconButton({ label, children, onClick, danger = false, disabled = false }: { label: string; children: React.ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean }) { return <button type="button" disabled={disabled} aria-label={label} title={label} onClick={onClick} className={danger ? "grid h-9 w-9 place-items-center rounded-lg text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:text-slate-400" : "grid h-9 w-9 place-items-center rounded-lg text-ink-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:text-slate-400"}>{children}</button>; }
