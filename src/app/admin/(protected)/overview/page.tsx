"use client";

import Link from "next/link";
import { ArrowRight, Files, Hourglass, Trash2, Upload, Warehouse } from "lucide-react";
import { useSession } from "@/components/providers";
import { useQuery } from "@/hooks/use-query";
import { Stat, UsageBar, RelativeTime } from "@/components/ui/data";
import { CardsSkeleton, ErrorState } from "@/components/ui/feedback";
import { openUploadModal } from "@/components/shell/admin-shell";
import { formatBytes, formatNumber } from "@/utils/format";
import type { SerializedFile } from "@/types/file";

interface StoragePayload {
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
    pendingUploadBytes: number;
  };
  source: "live" | "fallback";
  blob: { reachable: boolean; latencyMs: number };
}

interface ActivityItem {
  id: string;
  actor: string;
  description: string;
  fileId: string | null;
  createdAt: string;
}

export default function OverviewPage() {
  const { session } = useSession();
  const canManage = session?.role === "admin" || session?.role === "editor";
  const storage = useQuery<StoragePayload>("/api/storage");
  const activity = useQuery<{ activity: ActivityItem[] }>("/api/activity?pageSize=8");
  const expiring = useQuery<{ files: SerializedFile[] }>("/api/files?pageSize=5&status=active&filter=expiring_soon&sort=delete_date");
  const recent = useQuery<{ files: SerializedFile[] }>("/api/files?pageSize=5&status=active&filter=active&sort=newest");

  if (storage.loading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="page-title">Overview</h1>
          <p className="page-sub">Manage your organization&apos;s documents and storage.</p>
        </div>
        <CardsSkeleton />
      </div>
    );
  }

  if (storage.error || !storage.data) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="page-title">Overview</h1>
          <p className="page-sub">Manage your organization&apos;s documents and storage.</p>
        </div>
        <div className="tbl-wrap"><ErrorState message={storage.error ?? "Dashboard unavailable."} onRetry={storage.refresh} /></div>
      </div>
    );
  }

  const stats = storage.data.stats;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">Overview</h1>
          <p className="page-sub">Manage your organization&apos;s documents and storage.</p>
        </div>
        {canManage && (
          <button type="button" className="btn-primary btn-sm" onClick={openUploadModal}>
            <Upload className="h-4 w-4" /> Upload PDF
          </button>
        )}
      </div>
      {storage.data.source === "fallback" && (
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-200" role="status">
          Live storage metrics are temporarily unavailable. Displayed totals are degraded and not authoritative; retry to reconnect.
          <button type="button" className="btn-ghost btn-sm ml-2 align-middle" onClick={storage.refresh}>Retry</button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Total files" value={formatNumber(stats.activeFileCount)} detail={`${formatNumber(stats.totalPdfCount)} including Trash`} icon={<Files className="h-4 w-4" />} />
        <Stat label="Storage used" value={formatBytes(stats.totalStorageBytes)} detail={`${stats.usagePercent}% of ${formatBytes(stats.storageLimitBytes)}`} icon={<Warehouse className="h-4 w-4" />} />
        <Stat label="Files in Trash" value={formatNumber(stats.trashFileCount)} detail={`${formatBytes(stats.trashStorageBytes)} recoverable`} icon={<Trash2 className="h-4 w-4" />} />
        <Stat label="Expiring soon" value={formatNumber(stats.expiringSoonCount)} detail="Within the next 30 days" icon={<Hourglass className="h-4 w-4" />} />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="card-pad xl:col-span-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="panel-title">Storage analytics</h2>
              <p className="panel-sub">Private Blob store usage against the configured limit.</p>
            </div>
            <Link href="/admin/storage" className="btn-ghost btn-sm">Details <ArrowRight className="h-3.5 w-3.5" /></Link>
          </div>
          <div className="mt-4">
            <div className="flex items-baseline justify-between gap-3">
              <p className="tnum text-sm font-medium text-ink">{formatBytes(stats.totalStorageBytes)} / {formatBytes(stats.storageLimitBytes)}</p>
              <p className="tnum text-sm text-ink-muted">{stats.usagePercent}%</p>
            </div>
            <div className="mt-2"><UsageBar percent={stats.usagePercent} tone={stats.warningLevel === "normal" ? "default" : stats.warningLevel} /></div>
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg bg-surface-sunken p-3">
              <dt className="text-xs text-ink-muted">Active</dt>
              <dd className="tnum mt-1 text-sm font-semibold text-ink">{formatBytes(stats.activeStorageBytes)}</dd>
            </div>
            <div className="rounded-lg bg-surface-sunken p-3">
              <dt className="text-xs text-ink-muted">Trash</dt>
              <dd className="tnum mt-1 text-sm font-semibold text-ink">{formatBytes(stats.trashStorageBytes)}</dd>
            </div>
            <div className="rounded-lg bg-surface-sunken p-3">
              <dt className="text-xs text-ink-muted">Available</dt>
              <dd className="tnum mt-1 text-sm font-semibold text-ink">{formatBytes(stats.availableBytes)}</dd>
            </div>
            <div className="rounded-lg bg-surface-sunken p-3">
              <dt className="text-xs text-ink-muted">Blob store</dt>
              <dd className="mt-1 text-sm font-semibold text-ink">{storage.data.blob.reachable ? <span className="badge-success">Connected</span> : <span className="badge-danger">Unreachable</span>}</dd>
            </div>
          </dl>
        </div>

        <div className="card-pad">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="panel-title">Recent activity</h2>
              <p className="panel-sub">Latest events across the platform.</p>
            </div>
            <Link href="/admin/activity" className="btn-ghost btn-sm">All <ArrowRight className="h-3.5 w-3.5" /></Link>
          </div>
          <ul className="mt-4 space-y-3.5">
            {activity.loading && Array.from({ length: 5 }).map((_, index) => (
              <li key={index} className="flex gap-2.5"><div className="skeleton mt-1.5 h-2 w-2 rounded-full" /><div className="flex-1 space-y-1.5"><div className="skeleton h-3.5 w-full" /><div className="skeleton h-3 w-20" /></div></li>
            ))}
            {activity.data?.activity.map((item) => (
              <li key={item.id} className="flex gap-2.5 text-[13px]">
                <span className="dot mt-1.5 shrink-0 bg-blue-500" />
                <div className="min-w-0">
                  <p className="leading-5 text-ink"><span className="font-medium">{item.actor}</span> <span className="text-ink-muted">{item.description}</span></p>
                  <RelativeTime iso={item.createdAt} className="text-xs text-ink-faint" />
                </div>
              </li>
            ))}
            {!activity.loading && (activity.data?.activity.length ?? 0) === 0 && (
              <li className="py-4 text-center text-[13px] text-ink-faint">No activity yet.</li>
            )}
          </ul>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="card-pad">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="panel-title">Expiring soon</h2>
              <p className="panel-sub">Retention expires within 30 days.</p>
            </div>
            <Link href="/admin/retention" className="btn-ghost btn-sm">Retention <ArrowRight className="h-3.5 w-3.5" /></Link>
          </div>
          <ul className="mt-3 divide-y divide-line">
            {(expiring.data?.files ?? []).map((file) => (
              <li key={file.id} className="flex items-center justify-between gap-3 py-2.5 text-[13px]">
                <Link href={`/admin/files?preview=${file.id}`} className="min-w-0 flex-1 truncate font-medium text-ink hover:underline">
                  {file.title || file.originalName}
                </Link>
                <RelativeTime iso={file.deleteAt} className="tnum shrink-0 text-xs text-amber-600 dark:text-amber-400" />
              </li>
            ))}
            {!expiring.loading && (expiring.data?.files.length ?? 0) === 0 && (
              <li className="py-4 text-center text-[13px] text-ink-faint">Nothing expiring in the next 30 days.</li>
            )}
          </ul>
        </div>
        <div className="card-pad">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="panel-title">Recent uploads</h2>
              <p className="panel-sub">Newest documents in the library.</p>
            </div>
            <Link href="/admin/recent" className="btn-ghost btn-sm">Recent <ArrowRight className="h-3.5 w-3.5" /></Link>
          </div>
          <ul className="mt-3 divide-y divide-line">
            {(recent.data?.files ?? []).map((file) => (
              <li key={file.id} className="flex items-center justify-between gap-3 py-2.5 text-[13px]">
                <Link href={`/admin/files?preview=${file.id}`} className="min-w-0 flex-1 truncate font-medium text-ink hover:underline">
                  {file.title || file.originalName}
                </Link>
                <span className="tnum shrink-0 text-xs text-ink-faint">{formatBytes(file.size)}</span>
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
