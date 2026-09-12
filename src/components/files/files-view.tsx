"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Filter, Heart, Trash2, ArchiveRestore, Upload, X } from "lucide-react";
import { useConfirm, useSession, useToast } from "@/components/providers";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useQuery } from "@/hooks/use-query";
import { SearchInput } from "@/components/ui/data";
import { Dropdown } from "@/components/ui/overlays";
import { Spinner, TableSkeleton, ErrorState } from "@/components/ui/feedback";
import { apiErrorOptions, apiFetch } from "@/lib/client/api";
import type { SerializedFile } from "@/types/file";
import { openUploadModal } from "@/components/shell/admin-shell";
import { ColumnToggle, FILE_COLUMNS, FileTable, type FileSortKey } from "@/components/files/file-table";
import { FileDrawer } from "@/components/files/file-drawer";
import { MetadataModal } from "@/components/files/metadata-modal";
import { PdfViewer } from "@/components/files/pdf-viewer";

interface ListResponse {
  files: SerializedFile[];
  nextCursor: string | null;
  searchLimited: boolean;
  /** True when the read was served without the composite PostgreSQL index. */
  pagination?: { count: number; pageSize: number; nextCursor: string | null; hasMore: boolean };
}

const SORT_MAP: Record<FileSortKey, Record<"asc" | "desc", string>> = {
  name: { asc: "name", desc: "name" },
  size: { asc: "smallest", desc: "largest" },
  createdAt: { asc: "oldest", desc: "newest" },
  deleteAt: { asc: "delete_date", desc: "delete_date" },
};

export function FilesView({
  mode,
  title,
  description,
  emptyTitle,
  emptyDescription,
}: {
  mode: "files" | "recent" | "favorites" | "trash";
  title: string;
  description: string;
  emptyTitle: string;
  emptyDescription: string;
}) {
  const { session } = useSession();
  const { toast } = useToast();
  const confirm = useConfirm();
  const searchParams = useSearchParams();
  const canManage = session?.role === "admin" || session?.role === "editor";

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [retention, setRetention] = useState("");
  const [sort, setSort] = useState<{ key: FileSortKey; dir: "asc" | "desc" }>({ key: "createdAt", dir: "desc" });
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(() => new Set(FILE_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.id)));
  const [manualPreview, setManualPreview] = useState<SerializedFile | null>(null);
  const [dismissedPreviewId, setDismissedPreviewId] = useState<string | null>(null);
  const [detailsFile, setDetailsFile] = useState<SerializedFile | null>(null);
  const [editFile, setEditFile] = useState<SerializedFile | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkAction, setBulkAction] = useState<"trash" | "restore" | "delete" | "favorite" | null>(null);
  const bulkBusyRef = useRef(false);
  const [emptyTrashBusy, setEmptyTrashBusy] = useState(false);
  const emptyTrashBusyRef = useRef(false);

  // Keep free-text search independent from structured filters. The API applies
  // category and retention as exact filters instead of searching for their
  // labels in the document text.
  const debouncedSearch = useDebouncedValue(search.trim());
  const trashView = mode === "trash";

  const filter = mode === "recent" ? "recent" : mode === "favorites" ? "favorites" : mode === "trash" ? "trash" : "all";
  const status = trashView ? "trash" : "active";
  const apiSort = SORT_MAP[sort.key][sort.dir];

  const url = useMemo(() => {
    const params = new URLSearchParams({
      pageSize: "25",
      status,
      filter,
      sort: apiSort,
      search: debouncedSearch,
    });
    if (category.trim()) params.set("category", category.trim());
    if (retention) params.set("retention", retention);
    if (cursor) params.set("cursor", cursor);
    return `/api/files?${params.toString()}`;
  }, [status, filter, apiSort, debouncedSearch, category, retention, cursor]);

  const { data, errorInfo, loading, refresh } = useQuery<ListResponse>(url);
  const { data: categoryData } = useQuery<{ categories: { name: string }[] }>("/api/categories");

  // Explicit retry that visibly does something: it re-runs the same query and
  // keeps the button in a busy state until that request settles. No effect is
  // needed — `loading` already tells us when the retry finished.
  const [retryToken, setRetryToken] = useState(0);
  const retrying = retryToken > 0 && loading;
  const retry = useCallback(() => {
    setRetryToken((value) => value + 1);
    refresh();
  }, [refresh]);

  // Reset pagination/selection when filters change (render-adjust, not an effect).
  const filterKey = `${debouncedSearch}|${category}|${retention}|${status}|${filter}|${apiSort}`;
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (lastFilterKey !== filterKey) {
    setLastFilterKey(filterKey);
    setCursor(null);
    setCursorStack([]);
    setSelected(new Set());
  }

  useEffect(() => {
    const onChanged = () => refresh();
    window.addEventListener("nfc:files-changed", onChanged);
    return () => window.removeEventListener("nfc:files-changed", onChanged);
  }, [refresh]);

  const toggleSelect = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    if (!data) return;
    setSelected((current) => {
      const next = new Set(current);
      const pageSelected = data.files.length > 0 && data.files.every((file) => next.has(file.id));
      for (const file of data.files) {
        if (pageSelected) next.delete(file.id);
        else next.add(file.id);
      }
      return next;
    });
  }, [data]);

  const handleSort = useCallback((key: FileSortKey) => {
    setSort((current) => (current.key === key ? { key, dir: current.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  }, []);

  const bulk = async (action: "trash" | "restore" | "delete" | "favorite", extra: Record<string, unknown> = {}) => {
    if (bulkBusyRef.current) return;
    const ids = [...selected];
    if (ids.length === 0) return;
    bulkBusyRef.current = true;
    setBulkBusy(true);
    setBulkAction(action);
    try {
      if (action === "delete") {
        const ok = await confirm({
          title: `Delete ${ids.length} file(s) permanently?`,
          description: "Their private stored bytes will be permanently deleted. This action cannot be undone.",
          confirmLabel: "Delete permanently",
          tone: "danger",
          requireText: "DELETE",
        });
        if (!ok) return;
      } else if (action === "trash") {
        const ok = await confirm({
          title: `Move ${ids.length} file(s) to Trash?`,
          description: "They stay recoverable until Trash retention expires.",
          confirmLabel: "Move to Trash",
        });
        if (!ok) return;
      }
      const result = await apiFetch<{ succeeded: number; failed: number }>(`/api/files/bulk`, {
        method: "POST",
        body: JSON.stringify({ action, ids, ...extra }),
      });
      toast(`${result.succeeded} file(s) updated${result.failed > 0 ? `, ${result.failed} failed` : ""}.`, result.failed > 0 ? "warning" : "success");
      setSelected(new Set());
      refresh();
    } catch (bulkError) {
      const opts = apiErrorOptions(bulkError, "Bulk action failed. Try again.");
      toast(opts.message, "error", { requestId: opts.requestId, retry: () => void bulk(action, extra) });
    } finally {
      bulkBusyRef.current = false;
      setBulkBusy(false);
      setBulkAction(null);
    }
  };

  const emptyTrash = async () => {
    if (emptyTrashBusyRef.current) return;
    emptyTrashBusyRef.current = true;
    setEmptyTrashBusy(true);
    try {
      const ok = await confirm({
        title: "Empty Trash?",
        description: "Every file in Trash will be permanently deleted. This action cannot be undone.",
        confirmLabel: "Empty Trash",
        tone: "danger",
        requireText: "EMPTY_TRASH",
      });
      if (!ok) return;
      const result = await apiFetch<{ deleted: number; failed: number }>("/api/files/trash", {
        method: "DELETE",
        body: JSON.stringify({ confirmation: "EMPTY_TRASH" }),
      });
      if (result.failed > 0) {
        toast(`${result.deleted} file(s) permanently deleted; ${result.failed} could not be deleted. Try again for the remaining files.`, "warning");
      } else {
        toast(`Trash emptied. ${result.deleted} file(s) permanently deleted.`);
      }
      refresh();
    } catch (emptyError) {
      const opts = apiErrorOptions(emptyError, "Empty Trash failed. Try again.");
      toast(opts.message, "error", { requestId: opts.requestId, retry: () => void emptyTrash() });
    } finally {
      emptyTrashBusyRef.current = false;
      setEmptyTrashBusy(false);
    }
  };

  const files = data?.files ?? [];
  const filtersActive = Boolean(search.trim() || category.trim() || retention);

  // Deep-link preview (?preview=<id>) from command palette / activity, derived during render.
  const deepLinkId = searchParams.get("preview");
  const deepLinkedFile = deepLinkId && deepLinkId !== dismissedPreviewId
    ? files.find((file) => file.id === deepLinkId) ?? null
    : null;
  const previewFile = manualPreview ?? deepLinkedFile;
  const closePreview = useCallback(() => {
    setManualPreview(null);
    if (deepLinkId) {
      setDismissedPreviewId(deepLinkId);
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, [deepLinkId]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">{title}</h1>
          <p className="page-sub">{description}</p>
        </div>
        <div className="flex items-center gap-2">
          {trashView ? (
            session?.role === "admin" && (
              <button type="button" className="btn-danger-soft btn-sm" onClick={() => void emptyTrash()} disabled={emptyTrashBusy} aria-busy={emptyTrashBusy}>
                {emptyTrashBusy ? <Spinner className="h-4 w-4" /> : <Trash2 className="h-4 w-4" />} {emptyTrashBusy ? "Emptying…" : "Empty Trash"}
              </button>
            )
          ) : (
            canManage && (
              <button type="button" className="btn-primary btn-sm" onClick={openUploadModal}>
                <Upload className="h-4 w-4" /> Upload PDF
              </button>
            )
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="w-full min-w-[200px] flex-1 sm:max-w-sm">
          <SearchInput value={search} onChange={setSearch} placeholder="Search name, title, tags, uploader, ID…" shortcut="/" />
        </div>
        {!trashView && (
          <Dropdown label="Filter" trigger={
            <span role="button" tabIndex={0} className="btn-secondary btn-sm" aria-label="Filter files">
              <Filter className="h-4 w-4" /> <span className="hidden sm:inline">Filter</span>
              {filtersActive && search === "" && <span className="dot bg-blue-500" />}
            </span>
          } align="left">
            <div className="w-64 max-w-full min-w-0 p-3" onClick={(event) => event.stopPropagation()}>
              <label className="field-label" htmlFor="filter-category">Category</label>
              <input id="filter-category" className="field-input" value={category} onChange={(event) => setCategory(event.target.value)} placeholder="e.g. Finance" />
              <label className="field-label mt-3" htmlFor="filter-retention">Retention</label>
              <select id="filter-retention" className="field-input" value={retention} onChange={(event) => setRetention(event.target.value)}>
                <option value="">Any retention</option>
                <option value="30_days">30 days</option>
                <option value="3_months">3 months</option>
                <option value="6_months">6 months</option>
                <option value="1_year">1 year</option>
                <option value="never">Never delete</option>
              </select>
              {(category || retention) && (
                <button type="button" className="btn-ghost btn-sm mt-3" onClick={() => { setCategory(""); setRetention(""); }}>
                  <X className="h-3.5 w-3.5" /> Clear filters
                </button>
              )}
            </div>
          </Dropdown>
        )}
        <ColumnToggle visible={visibleColumns} onToggle={(id) => setVisibleColumns((current) => {
          const next = new Set(current);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        })} />
      </div>

      {selected.size > 0 && (
        <div className="sticky top-16 z-30 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface-raised p-2.5 shadow-pop animate-slide-up dark:shadow-popdark" role="toolbar" aria-label="Bulk actions">
          <span className="px-1.5 text-[13px] font-medium text-ink">{selected.size} selected</span>
          <button type="button" className="btn-ghost btn-sm" onClick={() => setSelected(new Set())}>Clear</button>
          <span className="mx-1 hidden h-5 border-l border-line sm:block" />
          {!trashView && canManage && (
            <>
              <button type="button" className="btn-secondary btn-sm" disabled={bulkBusy} aria-busy={bulkAction === "favorite"} onClick={() => void bulk("favorite", { isFavorite: true })}>
                {bulkAction === "favorite" ? <Spinner className="h-3.5 w-3.5" /> : <Heart className="h-3.5 w-3.5" />} {bulkAction === "favorite" ? "Updating…" : "Favorite"}
              </button>
              <button type="button" className="btn-secondary btn-sm" disabled={bulkBusy} aria-busy={bulkAction === "trash"} onClick={() => void bulk("trash")}>
                {bulkAction === "trash" ? <Spinner className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />} {bulkAction === "trash" ? "Updating…" : "Move to Trash"}
              </button>
            </>
          )}
          {trashView && canManage && (
            <button type="button" className="btn-secondary btn-sm" disabled={bulkBusy} aria-busy={bulkAction === "restore"} onClick={() => void bulk("restore")}>
              {bulkAction === "restore" ? <Spinner className="h-3.5 w-3.5" /> : <ArchiveRestore className="h-3.5 w-3.5" />} {bulkAction === "restore" ? "Updating…" : "Restore"}
            </button>
          )}
          {session?.role === "admin" && (
            <button type="button" className="btn-danger-soft btn-sm" disabled={bulkBusy} aria-busy={bulkAction === "delete"} onClick={() => void bulk("delete")}>
              {bulkAction === "delete" ? <Spinner className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />} {bulkAction === "delete" ? "Updating…" : "Delete permanently"}
            </button>
          )}
        </div>
      )}

      {loading && !data && <TableSkeleton />}
      {errorInfo && !data && !loading && (
        <div className="tbl-wrap">
          <ErrorState
            message={errorInfo.message}
            onRetry={refresh}
            busy={retrying}
            detail={{
              code: errorInfo.code,
              requestId: errorInfo.requestId,
            }}
          />
        </div>
      )}
      {data && (
        <>
          {loading && (
            <div className="flex items-center gap-2 text-xs text-ink-muted" role="status" aria-live="polite">
              <Spinner className="h-3.5 w-3.5" /> Refreshing files…
            </div>
          )}
          {errorInfo && (
            <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2.5 text-sm text-red-700 dark:text-red-300" role="alert">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="font-medium">{errorInfo.message}</span>
                <button type="button" className="btn-secondary btn-sm" onClick={retry} disabled={retrying}>
                  {retrying ? "Retrying…" : "Retry"}
                </button>
              </div>
              <p className="mt-1 font-mono text-[11px] opacity-80">
                {[errorInfo.code, errorInfo.requestId ? `request ${errorInfo.requestId}` : null].filter(Boolean).join(" · ")}
              </p>
            </div>
          )}
          <FileTable
            files={files}
            selected={selected}
            onToggleSelect={toggleSelect}
            onToggleAll={toggleAll}
            allSelected={files.length > 0 && files.every((file) => selected.has(file.id))}
            sort={sort}
            onSort={handleSort}
            visibleColumns={visibleColumns}
            onOpen={setManualPreview}
            onDetails={setDetailsFile}
            onEdit={setEditFile}
            hasPrev={cursorStack.length > 0}
            hasNext={Boolean(data.nextCursor)}
            onPrev={() => {
              setCursorStack((stack) => {
                const next = [...stack];
                next.pop();
                setCursor(next[next.length - 1] ?? null);
                return next;
              });
            }}
            onNext={() => {
              if (!data.nextCursor) return;
              setCursorStack((stack) => [...stack, data.nextCursor!]);
              setCursor(data.nextCursor);
            }}
            pageLabel={data.searchLimited ? "Results limited to the 1,000 most recent matches. Refine your search." : `${files.length} file(s)`}
            empty={{ title: emptyTitle, description: filtersActive ? "Try changing your search or filters." : emptyDescription }}
            refresh={refresh}
            trashView={trashView}
            loading={loading}
          />
        </>
      )}

      {previewFile && <PdfViewer file={previewFile} onClose={closePreview} />}
      {detailsFile && (
        <FileDrawer
          file={detailsFile}
          onClose={() => setDetailsFile(null)}
          onEdit={() => { setEditFile(detailsFile); }}
          onPreview={() => { setManualPreview(detailsFile); setDetailsFile(null); }}
          refresh={() => { refresh(); }}
        />
      )}
      {editFile && (
        <MetadataModal
          file={editFile}
          categories={(categoryData?.categories ?? []).map((item) => item.name)}
          onClose={() => setEditFile(null)}
          onSaved={() => { setEditFile(null); setDetailsFile(null); refresh(); }}
        />
      )}
    </div>
  );
}

