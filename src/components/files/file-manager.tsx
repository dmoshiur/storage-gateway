"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive, ChevronLeft, ChevronRight, Filter, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { PageLoading } from "@/components/ui/loading";
import { FileUploadForm } from "@/components/files/file-upload-form";
import { FileTable } from "@/components/files/file-table";
import { EditFileDialog, MoveToTrashDialog, PermanentDeleteDialog, RestoreDialog } from "@/components/files/file-dialogs";
import { apiFetch, ClientApiError } from "@/lib/client/api";
import type { FileFilter, FileSort, SerializedFile } from "@/types/file";

interface FileListResponse { files: SerializedFile[]; nextCursor: string | null; searchLimited: boolean; }
interface PageRequest { trash: boolean; filter: FileFilter; sort: FileSort; search: string; cursor?: string | null; }

function fetchFilePage({ trash, filter, sort, search, cursor }: PageRequest) {
  const params = new URLSearchParams({ pageSize: "25", status: trash ? "trash" : "active", filter: trash ? "trash" : filter, sort, search });
  if (cursor) params.set("cursor", cursor);
  return apiFetch<FileListResponse>(`/api/files?${params.toString()}`);
}

export function FileManager({ trash = false, canManage = true }: { trash?: boolean; canManage?: boolean }) {
  const [files, setFiles] = useState<SerializedFile[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([]);
  const [currentCursor, setCurrentCursor] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [filter, setFilter] = useState<FileFilter>(trash ? "trash" : "all");
  const [sort, setSort] = useState<FileSort>(trash ? "delete_date" : "newest");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchLimited, setSearchLimited] = useState(false);
  const [editing, setEditing] = useState<SerializedFile | null>(null);
  const [moving, setMoving] = useState<SerializedFile | null>(null);
  const [restoring, setRestoring] = useState<SerializedFile | null>(null);
  const [permanentlyDeleting, setPermanentlyDeleting] = useState<SerializedFile | null>(null);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedSearch(search), 280);
    return () => window.clearTimeout(timeout);
  }, [search]);

  // Query changes reset pagination. State changes happen after the async network boundary.
  useEffect(() => {
    let alive = true;
    fetchFilePage({ trash, filter, sort, search: debouncedSearch }).then((result) => {
      if (!alive) return;
      setFiles(result.files); setNextCursor(result.nextCursor); setCurrentCursor(null); setCursorStack([]); setSearchLimited(result.searchLimited); setError(null);
    }).catch((caught) => {
      if (alive) setError(caught instanceof ClientApiError ? caught.message : "Files could not be loaded right now.");
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [debouncedSearch, filter, sort, trash]);

  const loadPage = useCallback(async (cursor: string | null) => {
    setLoading(true); setError(null);
    try {
      const result = await fetchFilePage({ trash, filter, sort, search: debouncedSearch, cursor });
      setFiles(result.files); setNextCursor(result.nextCursor); setCurrentCursor(cursor); setSearchLimited(result.searchLimited);
    } catch (caught) {
      setError(caught instanceof ClientApiError ? caught.message : "Files could not be loaded right now.");
    } finally { setLoading(false); }
  }, [debouncedSearch, filter, sort, trash]);

  const refresh = useCallback(() => { void loadPage(currentCursor); }, [currentCursor, loadPage]);
  const goNext = () => {
    if (!nextCursor) return;
    setCursorStack((stack) => [...stack, currentCursor]);
    void loadPage(nextCursor);
  };
  const goPrevious = () => {
    const previous = cursorStack.at(-1);
    if (previous === undefined) return;
    setCursorStack((stack) => stack.slice(0, -1));
    void loadPage(previous);
  };
  const summary = useMemo(() => files.length === 1 ? "1 PDF" : `${files.length} PDFs`, [files.length]);

  return <div className="space-y-6">
    <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><p className="text-sm font-semibold uppercase tracking-wider text-ngo-600">{trash ? "Recovery area" : "Private document library"}</p><h1 className="mt-1 text-2xl font-bold tracking-tight text-ink-900 sm:text-3xl">{trash ? "Trash" : "Manage PDFs"}</h1><p className="mt-2 text-sm text-slate-600">{trash ? "Restore documents before their scheduled permanent deletion." : "Search, retain, view, and safely manage private NGO documents."}</p></div>{trash && <span className="inline-flex items-center gap-2 text-sm font-semibold text-amber-800"><Archive className="h-5 w-5" />Files remain recoverable while in Trash</span>}</header>
    {!canManage && <Notice type="info">You have read-only access. Viewing and downloading are available; uploading, editing, and deletion require administrator permission.</Notice>}
    {!trash && canManage && <FileUploadForm onUploaded={refresh} />}
    <section className="panel p-4 sm:p-5"><div className="flex flex-col gap-3 lg:flex-row lg:items-center"><div className="relative flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><label className="sr-only" htmlFor={trash ? "trash-search" : "files-search"}>Search PDFs</label><input id={trash ? "trash-search" : "files-search"} className="field-input pl-9" value={search} onChange={(event) => { setSearch(event.target.value); setLoading(true); }} placeholder="Search filename, title, description, category, or tag" /></div>{!trash && <><div className="flex items-center gap-2"><Filter className="h-4 w-4 text-slate-500" aria-hidden="true" /><label className="sr-only" htmlFor="file-filter">Filter PDFs</label><select id="file-filter" className="field-input w-auto" value={filter} onChange={(event) => { setFilter(event.target.value as FileFilter); setLoading(true); }}><option value="all">All active</option><option value="auto_delete">Auto-delete enabled</option><option value="never_delete">Never delete</option><option value="expiring_soon">Expiring soon</option><option value="expired">Expired</option></select></div></>}<div><label className="sr-only" htmlFor="file-sort">Sort PDFs</label><select id="file-sort" className="field-input w-full lg:w-auto" value={sort} onChange={(event) => { setSort(event.target.value as FileSort); setLoading(true); }}><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="largest">Largest first</option><option value="smallest">Smallest first</option><option value="delete_date">Delete date</option></select></div><Button variant="secondary" className="shrink-0" onClick={refresh} disabled={loading}><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />Refresh</Button></div>
      {error && <div className="mt-4"><Notice type="error">{error}</Notice></div>}{searchLimited && <div className="mt-4"><Notice type="warning">Search results are limited to the first 1,000 matching storage records. Narrow your terms if you cannot find an older PDF.</Notice></div>}
      <div className="mt-5">{loading && files.length === 0 ? <PageLoading label="Loading PDFs" /> : <FileTable files={files} trash={trash} canManage={canManage} loading={loading} onEdit={setEditing} onTrash={setMoving} onRestore={setRestoring} onPermanentDelete={setPermanentlyDeleting} />}</div>
      <div className="mt-4 flex flex-col gap-3 border-t border-slate-100 pt-4 sm:flex-row sm:items-center sm:justify-between"><p className="text-sm text-slate-600">Showing {summary}{currentCursor ? " on this page" : ""}</p><div className="flex gap-2"><Button variant="secondary" onClick={goPrevious} disabled={loading || cursorStack.length === 0}><ChevronLeft className="h-4 w-4" />Previous</Button><Button variant="secondary" onClick={goNext} disabled={loading || !nextCursor}>Next<ChevronRight className="h-4 w-4" /></Button></div></div>
    </section>
    <EditFileDialog file={editing} onClose={() => setEditing(null)} onSaved={refresh} />
    <MoveToTrashDialog file={moving} onClose={() => setMoving(null)} onMoved={refresh} />
    <RestoreDialog file={restoring} onClose={() => setRestoring(null)} onRestored={refresh} />
    <PermanentDeleteDialog file={permanentlyDeleting} onClose={() => setPermanentlyDeleting(null)} onDeleted={refresh} />
  </div>;
}
