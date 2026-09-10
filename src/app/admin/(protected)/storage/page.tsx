"use client";

import Link from "next/link";
import { useQuery } from "@/hooks/use-query";
import { Stat, UsageBar, RelativeTime } from "@/components/ui/data";
import { CardsSkeleton, ErrorState } from "@/components/ui/feedback";
import { formatBytes, formatNumber } from "@/utils/format";
import type { SerializedFile } from "@/types/file";

interface StoragePayload {
  source: "live" | "fallback";
  stats: {
    totalPdfCount: number;
    activeFileCount: number;
    trashFileCount: number;
    totalStorageBytes: number;
    storageLimitBytes: number;
    activeStorageBytes: number;
    trashStorageBytes: number;
    availableBytes: number;
    usagePercent: number;
    warningLevel: "normal" | "warning" | "critical";
    expiringSoonCount: number;
  };
  blob: { reachable: boolean; latencyMs: number };
}

export default function StoragePage() {
  const storage = useQuery<StoragePayload>("/api/storage");
  const largest = useQuery<{ files: SerializedFile[] }>("/api/files?pageSize=8&status=active&filter=active&sort=largest");
  const recent = useQuery<{ files: SerializedFile[] }>("/api/files?pageSize=8&status=active&filter=active&sort=newest");

  if (storage.loading) {
    return (
      <div className="space-y-6">
        <div><h1 className="page-title">Storage</h1><p className="page-sub">Usage, growth, and largest documents.</p></div>
        <CardsSkeleton />
      </div>
    );
  }
  if (storage.error || !storage.data) {
    return (
      <div className="space-y-6">
        <div><h1 className="page-title">Storage</h1><p className="page-sub">Usage, growth, and largest documents.</p></div>
        <div className="tbl-wrap"><ErrorState message={storage.error ?? "Storage data unavailable."} onRetry={storage.refresh} /></div>
      </div>
    );
  }

  const stats = storage.data.stats;
  const avg = stats.activeFileCount > 0 ? stats.activeStorageBytes / stats.activeFileCount : 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">Storage</h1>
        <p className="page-sub">Usage, growth, and largest documents across the private Blob store.</p>
      </div>
      {storage.data.source === "fallback" && (
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-200" role="status">
          Live storage metrics are temporarily unavailable. Displayed totals are degraded and not authoritative; retry to reconnect.
          <button type="button" className="btn-ghost btn-sm ml-2 align-middle" onClick={storage.refresh}>Retry</button>
        </div>
      )}

      <div className="card-pad">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="panel-title">Storage overview</h2>
          {storage.data.blob.reachable
            ? <span className="badge-success">Blob store connected · {storage.data.blob.latencyMs} ms</span>
            : <span className="badge-danger">Blob store unreachable</span>}
        </div>
        <p className="tnum mt-3 text-3xl font-semibold tracking-tight text-ink">
          {formatBytes(stats.totalStorageBytes)} <span className="text-base font-normal text-ink-muted">/ {formatBytes(stats.storageLimitBytes)}</span>
        </p>
        <div className="mt-3"><UsageBar percent={stats.usagePercent} tone={stats.warningLevel === "normal" ? "default" : stats.warningLevel} /></div>
        <p className="tnum mt-2 text-[13px] text-ink-muted">{stats.usagePercent}% used · {formatBytes(stats.availableBytes)} available</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Active files" value={formatNumber(stats.activeFileCount)} detail={`${formatBytes(stats.activeStorageBytes)} bytes`} />
        <Stat label="Average file size" value={formatBytes(avg)} detail="Across active documents" />
        <Stat label="Trash" value={formatBytes(stats.trashStorageBytes)} detail={`${formatNumber(stats.trashFileCount)} recoverable files`} />
        <Stat label="Expiring soon" value={formatNumber(stats.expiringSoonCount)} detail="Retention expires in 30 days" />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="card-pad">
          <h2 className="panel-title">Largest files</h2>
          <p className="panel-sub">Top documents by size.</p>
          <ul className="mt-3 divide-y divide-line">
            {(largest.data?.files ?? []).map((file) => (
              <li key={file.id} className="flex items-center justify-between gap-3 py-2.5 text-[13px]">
                <Link href={`/admin/files?preview=${file.id}`} className="min-w-0 flex-1 truncate font-medium text-ink hover:underline">
                  {file.title || file.originalName}
                </Link>
                <span className="tnum shrink-0 text-ink-muted">{formatBytes(file.size)}</span>
              </li>
            ))}
            {!largest.loading && (largest.data?.files.length ?? 0) === 0 && (
              <li className="py-4 text-center text-[13px] text-ink-faint">No files yet.</li>
            )}
          </ul>
        </div>
        <div className="card-pad">
          <h2 className="panel-title">Recent uploads</h2>
          <p className="panel-sub">Newest documents and when they arrived.</p>
          <ul className="mt-3 divide-y divide-line">
            {(recent.data?.files ?? []).map((file) => (
              <li key={file.id} className="flex items-center justify-between gap-3 py-2.5 text-[13px]">
                <Link href={`/admin/files?preview=${file.id}`} className="min-w-0 flex-1 truncate font-medium text-ink hover:underline">
                  {file.title || file.originalName}
                </Link>
                <RelativeTime iso={file.createdAt} className="shrink-0 text-xs text-ink-faint" />
              </li>
            ))}
            {!recent.loading && (recent.data?.files.length ?? 0) === 0 && (
              <li className="py-4 text-center text-[13px] text-ink-faint">No uploads yet.</li>
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}
