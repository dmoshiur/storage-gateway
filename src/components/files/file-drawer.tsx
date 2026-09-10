"use client";

import { Download, Eye, Heart, Link2, Pencil } from "lucide-react";
import { Drawer } from "@/components/ui/overlays";
import { CopyButton } from "@/components/ui/data";
import type { SerializedFile } from "@/types/file";
import { formatBytes, formatDateTime, formatRetention } from "@/utils/format";
import { FileTypeIcon, RetentionLabel, StatusBadge, displayName, useFileActions } from "@/components/files/file-helpers";

function Row({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <dt className="shrink-0 text-[13px] text-ink-muted">{label}</dt>
      <dd className={`min-w-0 text-right text-[13px] font-medium text-ink ${mono ? "font-mono text-xs break-all" : ""}`}>{children}</dd>
    </div>
  );
}

export function FileDrawer({
  file,
  onClose,
  onEdit,
  onPreview,
  refresh,
}: {
  file: SerializedFile;
  onClose: () => void;
  onEdit: () => void;
  onPreview: () => void;
  refresh: () => void;
}) {
  const actions = useFileActions(refresh);

  return (
    <Drawer title="File Details" onClose={onClose}>
      <div className="flex items-start gap-3">
        <FileTypeIcon extension={file.extension} />
        <div className="min-w-0 flex-1">
          <h3 className="break-words text-[15px] font-semibold leading-6 text-ink">{displayName(file)}</h3>
          <p className="mt-0.5 break-all font-mono text-xs text-ink-faint">{file.originalName}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <StatusBadge file={file} />
            {file.isFavorite && <span className="badge-warning">Favorite</span>}
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <button type="button" className="btn-primary btn-sm" onClick={onPreview}><Eye className="h-3.5 w-3.5" /> Preview</button>
        <button type="button" className="btn-secondary btn-sm" onClick={() => actions.download(file)}><Download className="h-3.5 w-3.5" /> Download</button>
        {actions.canManage && (
          <>
            <button type="button" className="btn-secondary btn-sm" onClick={() => actions.toggleFavorite(file)}>
              <Heart className={`h-3.5 w-3.5 ${file.isFavorite ? "fill-amber-400 text-amber-400" : ""}`} />
              {file.isFavorite ? "Unfavorite" : "Favorite"}
            </button>
            <button type="button" className="btn-secondary btn-sm" onClick={() => actions.copyLink(file)}><Link2 className="h-3.5 w-3.5" /> Temp link</button>
            <button type="button" className="btn-secondary btn-sm col-span-2" onClick={onEdit}><Pencil className="h-3.5 w-3.5" /> Edit metadata & retention</button>
          </>
        )}
      </div>

      {file.description && (
        <div className="mt-5">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-faint">Description</h4>
          <p className="mt-1.5 text-[13px] leading-6 text-ink-muted">{file.description}</p>
        </div>
      )}

      <div className="mt-5">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-faint">Details</h4>
        <dl className="mt-1 divide-y divide-line">
          <Row label="Size"><span className="tnum">{formatBytes(file.size)}</span></Row>
          <Row label="Type">{file.mimeType}</Row>
          <Row label="Category">{file.category || "—"}</Row>
          <Row label="Uploaded">{formatDateTime(file.createdAt)}</Row>
          <Row label="Updated">{formatDateTime(file.updatedAt)}</Row>
          <Row label="Uploaded by"><span className="break-all">{file.uploadedBy}</span></Row>
          <Row label="Last previewed">{file.lastAccessedAt ? formatDateTime(file.lastAccessedAt) : "Never"}</Row>
          <Row label="Last downloaded">{file.lastDownloadedAt ? formatDateTime(file.lastDownloadedAt) : "Never"}</Row>
        </dl>
      </div>

      <div className="mt-5">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-faint">Retention</h4>
        <dl className="mt-1 divide-y divide-line">
          <Row label="Policy"><RetentionLabel file={file} /></Row>
          <Row label="Auto-delete">{file.autoDeleteEnabled ? "Enabled" : "Disabled"}</Row>
          <Row label="Delete on">{file.autoDeleteEnabled && file.deleteAt ? formatDateTime(file.deleteAt) : "—"}</Row>
          {file.status === "trash" && (
            <>
              <Row label="Deleted">{formatDateTime(file.deletedAt)}</Row>
              <Row label="Deleted by">{file.deletedBy ?? "—"}</Row>
              <Row label="Permanently deleted">{formatDateTime(file.permanentDeleteAt)}</Row>
            </>
          )}
        </dl>
      </div>

      {file.tags.length > 0 && (
        <div className="mt-5">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-faint">Tags</h4>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {file.tags.map((tag) => (
              <span key={tag} className="badge-neutral font-mono">#{tag}</span>
            ))}
          </div>
        </div>
      )}

      <div className="mt-5">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-faint">Technical</h4>
        <dl className="mt-1 divide-y divide-line">
          <Row label="File ID" mono>
            <span className="inline-flex items-center gap-1">
              {file.id} <CopyButton value={file.id} label="Copy file ID" />
            </span>
          </Row>
          {file.contentHash && (
            <Row label="SHA-256" mono>
              <span className="inline-flex items-center gap-1">
                {file.contentHash.slice(0, 16)}… <CopyButton value={file.contentHash} label="Copy content hash" />
              </span>
            </Row>
          )}
          <Row label="Retention">{formatRetention(file.retentionType, file.autoDeleteEnabled)} ({file.retentionType})</Row>
        </dl>
      </div>
    </Drawer>
  );
}
