"use client";

import { useState } from "react";
import Link from "next/link";
import { Activity as ActivityIcon } from "lucide-react";
import { useQuery } from "@/hooks/use-query";
import { RelativeTime } from "@/components/ui/data";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/ui/feedback";

interface ActivityItem {
  id: string;
  action: string;
  actor: string;
  actorType: string;
  description: string;
  fileId: string | null;
  fileName: string | null;
  createdAt: string;
}

export default function ActivityPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const { data, error, loading, refresh } = useQuery<{ activity: ActivityItem[]; nextCursor: string | null }>(
    `/api/activity?pageSize=30${cursor ? `&cursor=${cursor}` : ""}`,
  );

  // Accumulate pages as they arrive (render-adjust, not an effect).
  const [seenPage, setSeenPage] = useState<{ activity: ActivityItem[]; nextCursor: string | null } | null>(null);
  if (data && seenPage !== data) {
    setSeenPage(data);
    setItems((current) => {
      const ids = new Set(current.map((item) => item.id));
      return [...current, ...data.activity.filter((item) => !ids.has(item.id))];
    });
    setNext(data.nextCursor);
  }

  const loadMore = () => {
    if (next) setCursor(next);
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <h1 className="page-title">Activity</h1>
        <p className="page-sub">A human-friendly feed of everything happening in the platform.</p>
      </div>
      {loading && items.length === 0 && <TableSkeleton rows={8} columns={2} />}
      {error && items.length === 0 && <div className="tbl-wrap"><ErrorState message={error} onRetry={refresh} /></div>}
      {(!loading || items.length > 0) && !error && (
        <div className="card-pad">
          {items.length === 0 && !loading ? (
            <EmptyState icon={<ActivityIcon className="h-6 w-6" />} title="No activity yet" description="Uploads, downloads, and changes will appear here." />
          ) : (
            <ol className="relative space-y-5 before:absolute before:bottom-2 before:left-[5px] before:top-2 before:w-px before:bg-line-strong">
              {items.map((item) => (
                <li key={item.id} className="relative flex gap-3.5 pl-0 text-sm">
                  <span className={`dot relative z-10 mt-1.5 shrink-0 ${item.actorType === "system" ? "bg-slate-400" : item.actorType === "integration" ? "bg-violet-500" : "bg-blue-500"}`} />
                  <div className="min-w-0 flex-1">
                    <p className="leading-5 text-ink">
                      <span className="font-medium">{item.actor}</span> <span className="text-ink-muted">{item.description}</span>
                    </p>
                    <p className="mt-0.5 flex items-center gap-2 text-xs text-ink-faint">
                      <RelativeTime iso={item.createdAt} />
                      {item.fileId && (
                        <Link href={`/admin/files?preview=${item.fileId}`} className="link font-mono text-[11px]">
                          view file
                        </Link>
                      )}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}
          {next && (
            <div className="mt-5 text-center">
              <button type="button" className="btn-secondary btn-sm" onClick={loadMore} disabled={loading}>
                {loading ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
