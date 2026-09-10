"use client";

import { useState } from "react";
import Link from "next/link";
import { Hourglass } from "lucide-react";
import { useQuery } from "@/hooks/use-query";
import { RelativeTime } from "@/components/ui/data";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/ui/feedback";
import type { SerializedFile } from "@/types/file";
import { formatBytes, formatDate } from "@/utils/format";

function ExpiryGroup({ title, files, loading }: { title: string; files: SerializedFile[]; loading: boolean }) {
  return (
    <div className="card-pad">
      <h2 className="panel-title">{title}</h2>
      {loading ? (
        <div className="mt-3 space-y-2" aria-hidden="true">
          <div className="skeleton h-10 w-full" />
          <div className="skeleton h-10 w-full" />
        </div>
      ) : files.length === 0 ? (
        <p className="py-4 text-center text-[13px] text-ink-faint">Nothing here.</p>
      ) : (
        <ul className="mt-2 divide-y divide-line">
          {files.map((file) => (
            <li key={file.id} className="flex items-center justify-between gap-3 py-2.5 text-[13px]">
              <Link href={`/admin/files?preview=${file.id}`} className="min-w-0 flex-1 truncate font-medium text-ink hover:underline">
                {file.title || file.originalName}
              </Link>
              <span className="tnum shrink-0 text-xs text-ink-muted" title={formatDate(file.deleteAt)}>
                <RelativeTime iso={file.deleteAt} /> · {formatBytes(file.size)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function RetentionPage() {
  const expiring = useQuery<{ files: SerializedFile[] }>("/api/files?pageSize=50&status=active&filter=expiring_soon&sort=delete_date");
  const expired = useQuery<{ files: SerializedFile[] }>("/api/files?pageSize=50&status=active&filter=expired&sort=delete_date");
  const settings = useQuery<{ settings: { defaultAutoDelete: boolean; defaultRetentionType: string; trashEnabled: boolean; trashRetentionDays: number } }>("/api/settings");

  const files = expiring.data?.files ?? [];
  const [now] = useState(() => Date.now());
  const today = files.filter((file) => file.deleteAt && new Date(file.deleteAt).getTime() - now < 86400000);
  const week = files.filter((file) => {
    if (!file.deleteAt) return false;
    const ms = new Date(file.deleteAt).getTime() - now;
    return ms >= 86400000 && ms < 7 * 86400000;
  });
  const month = files.filter((file) => {
    if (!file.deleteAt) return false;
    const ms = new Date(file.deleteAt).getTime() - now;
    return ms >= 7 * 86400000;
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="page-title">Retention</h1>
        <p className="page-sub">Automatic deletion policies and upcoming expirations.</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="card-pad">
          <p className="stat-label">Default retention</p>
          <p className="mt-1 text-lg font-semibold text-ink">{settings.data ? settings.data.settings.defaultRetentionType.replace("_", " ") : "—"}</p>
          <p className="mt-1 text-xs text-ink-muted">Auto-delete {settings.data?.settings.defaultAutoDelete ? "on" : "off"} for new uploads</p>
        </div>
        <div className="card-pad">
          <p className="stat-label">Trash retention</p>
          <p className="mt-1 text-lg font-semibold text-ink">{settings.data ? `${settings.data.settings.trashRetentionDays} days` : "—"}</p>
          <p className="mt-1 text-xs text-ink-muted">Trash {settings.data?.settings.trashEnabled ? "enabled" : "disabled"}</p>
        </div>
        <div className="card-pad">
          <p className="stat-label">Expired, awaiting cleanup</p>
          <p className="tnum mt-1 text-lg font-semibold text-ink">{expired.data?.files.length ?? "—"}</p>
          <p className="mt-1 text-xs text-ink-muted">Moved to Trash by scheduled cleanup</p>
        </div>
      </div>

      {expiring.error && <div className="tbl-wrap"><ErrorState message={expiring.error} onRetry={expiring.refresh} /></div>}
      {!expiring.error && (
        <>
          {expiring.loading ? <TableSkeleton rows={4} columns={3} /> : files.length === 0 ? (
            <div className="tbl-wrap">
              <EmptyState icon={<Hourglass className="h-6 w-6" />} title="Nothing expiring soon" description="No active retention policies expire within the next 30 days." />
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
              <ExpiryGroup title="Expiring today" files={today} loading={expiring.loading} />
              <ExpiryGroup title="Expiring this week" files={week} loading={expiring.loading} />
              <ExpiryGroup title="Expiring this month" files={month} loading={expiring.loading} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
