"use client";

import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Columns3,
  Eye,
  Heart,
  MoreHorizontal,
} from "lucide-react";
import { Dropdown } from "@/components/ui/overlays";
import { Pagination } from "@/components/ui/data";
import { EmptyState } from "@/components/ui/feedback";
import type { SerializedFile } from "@/types/file";
import { formatBytes, formatDate, formatRelative, truncateMiddle } from "@/utils/format";
import { RetentionLabel, StatusBadge, displayName, useFileActions, FileTypeIcon, FILE_ACTION_ICONS } from "@/components/files/file-helpers";

export type FileSortKey = "name" | "size" | "createdAt" | "deleteAt";

export interface ColumnDef {
  id: string;
  label: string;
  defaultVisible: boolean;
}

export const FILE_COLUMNS: ColumnDef[] = [
  { id: "category", label: "Category", defaultVisible: true },
  { id: "size", label: "Size", defaultVisible: true },
  { id: "uploader", label: "Uploaded by", defaultVisible: true },
  { id: "uploaded", label: "Uploaded", defaultVisible: true },
  { id: "retention", label: "Retention", defaultVisible: true },
  { id: "status", label: "Status", defaultVisible: true },
];

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
}: {
  label: string;
  sortKey: FileSortKey;
  sort: { key: FileSortKey; dir: "asc" | "desc" };
  onSort: (key: FileSortKey) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      className="inline-flex items-center gap-1 uppercase hover:text-ink"
      aria-label={`Sort by ${label}`}
    >
      {label}
      {sort.key !== sortKey && <ArrowUpDown className="h-3 w-3 opacity-50" />}
      {sort.key === sortKey && sort.dir === "asc" && <ArrowUp className="h-3 w-3" />}
      {sort.key === sortKey && sort.dir === "desc" && <ArrowDown className="h-3 w-3" />}
    </button>
  );
}

export function FileTable({
  files,
  selected,
  onToggleSelect,
  onToggleAll,
  allSelected,
  sort,
  onSort,
  visibleColumns,
  onOpen,
  onDetails,
  onEdit,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  pageLabel,
  empty,
  refresh,
  trashView,
}: {
  files: SerializedFile[];
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  onToggleAll: () => void;
  allSelected: boolean;
  sort: { key: FileSortKey; dir: "asc" | "desc" };
  onSort: (key: FileSortKey) => void;
  visibleColumns: Set<string>;
  onOpen: (file: SerializedFile) => void;
  onDetails: (file: SerializedFile) => void;
  onEdit: (file: SerializedFile) => void;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  pageLabel: string;
  empty: { title: string; description: string };
  refresh: () => void;
  trashView?: boolean;
}) {
  const actions = useFileActions(refresh);

  const show = (id: string) => visibleColumns.has(id);

  if (files.length === 0) {
    return (
      <div className="tbl-wrap">
        <EmptyState title={empty.title} description={empty.description} />
      </div>
    );
  }

  return (
    <div className="tbl-wrap">
      <div className="hidden overflow-x-auto lg:block">
        <table className="tbl min-w-[900px]">
          <thead>
            <tr>
              <th className="w-10">
                <input
                  type="checkbox"
                  aria-label="Select all files on this page"
                  className="field-check"
                  checked={allSelected}
                  onChange={onToggleAll}
                />
              </th>
              <th><SortHeader label="Name" sortKey="name" sort={sort} onSort={onSort} /></th>
              {show("category") && <th>Category</th>}
              {show("size") && <th><SortHeader label="Size" sortKey="size" sort={sort} onSort={onSort} /></th>}
              {show("uploader") && <th>Uploaded by</th>}
              {show("uploaded") && <th><SortHeader label={trashView ? "Deleted" : "Uploaded"} sortKey="createdAt" sort={sort} onSort={onSort} /></th>}
              {show("retention") && !trashView && <th><SortHeader label="Retention" sortKey="deleteAt" sort={sort} onSort={onSort} /></th>}
              {show("retention") && trashView && <th>Permanently deleted</th>}
              {show("status") && <th>Status</th>}
              <th className="w-20 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {files.map((file) => {
              const PreviewIcon = FILE_ACTION_ICONS.preview;
              const DownloadIcon = FILE_ACTION_ICONS.download;
              const LinkIcon = FILE_ACTION_ICONS.copyLink;
              const FavoriteIcon = FILE_ACTION_ICONS.favorite;
              const EditIcon = FILE_ACTION_ICONS.edit;
              const TrashIcon = FILE_ACTION_ICONS.trash;
              const RestoreIcon = FILE_ACTION_ICONS.restore;
              return (
                <tr key={file.id} data-selected={selected.has(file.id)}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${displayName(file)}`}
                      className="field-check"
                      checked={selected.has(file.id)}
                      onChange={() => onToggleSelect(file.id)}
                    />
                  </td>
                  <td>
                    <div className="flex min-w-0 items-center gap-2.5">
                      <FileTypeIcon extension={file.extension} />
                      <div className="min-w-0">
                        <button
                          type="button"
                          onClick={() => onOpen(file)}
                          title={displayName(file)}
                          className="block max-w-[280px] truncate text-left text-[13px] font-medium text-ink hover:underline"
                        >
                          {truncateMiddle(displayName(file), 44)}
                        </button>
                        <p className="truncate font-mono text-[11px] text-ink-faint" title={file.originalName}>
                          {truncateMiddle(file.originalName, 44)}
                        </p>
                      </div>
                      {file.isFavorite && <Heart className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-400" aria-label="Favorite" />}
                    </div>
                  </td>
                  {show("category") && (
                    <td>{file.category ? <span className="badge-neutral">{file.category}</span> : <span className="text-ink-faint">—</span>}</td>
                  )}
                  {show("size") && <td className="tnum whitespace-nowrap">{formatBytes(file.size)}</td>}
                  {show("uploader") && (
                    <td className="max-w-[160px] truncate text-[13px] text-ink-muted" title={file.uploadedBy}>
                      {file.uploadedBy.startsWith("bridge:") ? "Website API" : file.uploadedBy}
                    </td>
                  )}
                  {show("uploaded") && (
                    <td className="whitespace-nowrap text-[13px] text-ink-muted" title={formatDate(trashView ? file.deletedAt : file.createdAt)}>
                      {formatRelative(trashView ? file.deletedAt : file.createdAt)}
                    </td>
                  )}
                  {show("retention") && !trashView && (
                    <td className="text-[13px] text-ink-muted"><RetentionLabel file={file} /></td>
                  )}
                  {show("retention") && trashView && (
                    <td className="whitespace-nowrap text-[13px] text-ink-muted">{formatRelative(file.permanentDeleteAt)}</td>
                  )}
                  {show("status") && <td><StatusBadge file={file} /></td>}
                  <td className="text-right">
                    <div className="flex items-center justify-end gap-0.5">
                      {!trashView && (
                        <button type="button" aria-label={`Preview ${displayName(file)}`} title="Preview" onClick={() => onOpen(file)} className="btn-icon h-7 w-7">
                          <Eye className="h-4 w-4" />
                        </button>
                      )}
                      <Dropdown
                        label={`Actions for ${displayName(file)}`}
                        trigger={
                          <span role="button" tabIndex={0} aria-label={`Actions for ${displayName(file)}`} className="btn-icon h-7 w-7">
                            <MoreHorizontal className="h-4 w-4" />
                          </span>
                        }
                      >
                        {!trashView && (
                          <>
                            <button type="button" className="menu-item" onClick={() => onOpen(file)}><PreviewIcon className="h-4 w-4" /> Open preview</button>
                            <button type="button" className="menu-item" onClick={() => actions.download(file)}><DownloadIcon className="h-4 w-4" /> Download</button>
                            <button type="button" className="menu-item" onClick={() => actions.copyLink(file)}><LinkIcon className="h-4 w-4" /> Copy temporary link</button>
                            <button type="button" className="menu-item" onClick={() => onDetails(file)}><Eye className="h-4 w-4" /> View details</button>
                            <div className="menu-sep" />
                          </>
                        )}
                        {actions.canManage && !trashView && (
                          <>
                            <button type="button" className="menu-item" onClick={() => actions.toggleFavorite(file)}>
                              <FavoriteIcon className="h-4 w-4" /> {file.isFavorite ? "Remove favorite" : "Add to favorites"}
                            </button>
                            <button type="button" className="menu-item" onClick={() => onEdit(file)}><EditIcon className="h-4 w-4" /> Edit metadata</button>
                            <button type="button" className="menu-item" onClick={() => onEdit(file)}><EditIcon className="h-4 w-4" /> Change retention</button>
                            <div className="menu-sep" />
                            <button type="button" className="menu-item" onClick={() => actions.trash(file)}><TrashIcon className="h-4 w-4" /> Move to Trash</button>
                          </>
                        )}
                        {trashView && actions.canManage && (
                          <button type="button" className="menu-item" onClick={() => actions.restore(file)}><RestoreIcon className="h-4 w-4" /> Restore</button>
                        )}
                        {actions.canDestroy && (
                          <button type="button" className="menu-item" data-danger="true" onClick={() => actions.destroy(file)}><TrashIcon className="h-4 w-4" /> Delete permanently</button>
                        )}
                      </Dropdown>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {/* mobile cards */}
      <div className="divide-y divide-line lg:hidden">
        {files.map((file) => (
          <div key={`m-${file.id}`} className="flex items-center gap-3 p-3 lg:hidden">
            <input
              type="checkbox"
              aria-label={`Select ${displayName(file)}`}
              className="field-check"
              checked={selected.has(file.id)}
              onChange={() => onToggleSelect(file.id)}
            />
            <button type="button" className="flex min-w-0 flex-1 items-center gap-2.5 text-left" onClick={() => onDetails(file)}>
              <FileTypeIcon extension={file.extension} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-ink">{displayName(file)}</span>
                <span className="tnum block text-xs text-ink-faint">{formatBytes(file.size)} · {formatRelative(file.createdAt)}</span>
              </span>
            </button>
            <StatusBadge file={file} />
          </div>
        ))}
      </div>
      <Pagination hasPrev={hasPrev} hasNext={hasNext} onPrev={onPrev} onNext={onNext} label={pageLabel} />
    </div>
  );
}

export function ColumnToggle({ visible, onToggle }: { visible: Set<string>; onToggle: (id: string) => void }) {
  return (
    <Dropdown
      label="Toggle columns"
      trigger={
        <span role="button" tabIndex={0} className="btn-secondary btn-sm" aria-label="Toggle columns">
          <Columns3 className="h-4 w-4" /> <span className="hidden sm:inline">Columns</span>
        </span>
      }
    >
      <p className="menu-label">Visible columns</p>
      {FILE_COLUMNS.map((column) => (
        <label key={column.id} className="menu-item cursor-pointer gap-2.5" onClick={(event) => event.stopPropagation()}>
          <input
            type="checkbox"
            className="field-check"
            checked={visible.has(column.id)}
            onChange={() => onToggle(column.id)}
          />
          {column.label}
        </label>
      ))}
    </Dropdown>
  );
}
