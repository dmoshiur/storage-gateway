"use client";

import Link from "next/link";
import { Bell, CheckCheck, TriangleAlert, Info, CheckCircle2 } from "lucide-react";
import { useToast } from "@/components/providers";
import { useQuery } from "@/hooks/use-query";
import { RelativeTime } from "@/components/ui/data";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/ui/feedback";
import { apiFetch } from "@/lib/client/api";
import type { SerializedNotification } from "@/types/notification";

function toneIcon(type: SerializedNotification["type"]) {
  if (type === "storage_critical" || type === "cleanup_failed" || type === "security_event") {
    return <TriangleAlert className="h-4 w-4 text-red-500" />;
  }
  if (type === "storage_warning" || type === "file_expiring" || type === "api_key_expiring") {
    return <TriangleAlert className="h-4 w-4 text-amber-500" />;
  }
  if (type === "cleanup_completed") {
    return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
  }
  return <Info className="h-4 w-4 text-blue-500" />;
}

export default function NotificationsPage() {
  const { toast } = useToast();
  const { data, error, loading, refresh } = useQuery<{ notifications: SerializedNotification[]; unreadCount: number }>(
    "/api/notifications?limit=100",
  );

  const markRead = async (id: string) => {
    try {
      await apiFetch("/api/notifications", { method: "POST", body: JSON.stringify({ id }) });
      refresh();
    } catch {
      toast("Could not mark as read.", "error");
    }
  };

  const markAll = async () => {
    try {
      await apiFetch("/api/notifications", { method: "POST", body: JSON.stringify({ all: true }) });
      toast("All notifications marked as read.");
      refresh();
    } catch {
      toast("Could not mark all as read.", "error");
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">Notifications</h1>
          <p className="page-sub">
            {(data?.unreadCount ?? 0) > 0 ? `${data!.unreadCount} unread` : "You're all caught up."} Storage, cleanup, expiry, and security alerts land here.
          </p>
        </div>
        {(data?.unreadCount ?? 0) > 0 && (
          <button type="button" className="btn-secondary btn-sm" onClick={markAll}>
            <CheckCheck className="h-4 w-4" /> Mark all read
          </button>
        )}
      </div>
      {loading && <TableSkeleton rows={6} columns={2} />}
      {error && !loading && <div className="tbl-wrap"><ErrorState message={error} onRetry={refresh} /></div>}
      {!loading && !error && (data?.notifications.length ?? 0) === 0 && (
        <div className="tbl-wrap">
          <EmptyState icon={<Bell className="h-6 w-6" />} title="No notifications" description="Alerts about storage, cleanup, and expiring files will appear here." />
        </div>
      )}
      {!loading && !error && (data?.notifications.length ?? 0) > 0 && (
        <ul className="card divide-y divide-line overflow-hidden">
          {data!.notifications.map((item) => (
            <li key={item.id} className={`flex gap-3 p-4 ${item.read ? "" : "bg-blue-500/[0.04]"}`}>
              <span className="mt-0.5 shrink-0">{toneIcon(item.type)}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink">{item.title}</p>
                <p className="mt-0.5 text-[13px] leading-5 text-ink-muted">{item.message}</p>
                <p className="mt-1 flex items-center gap-2.5 text-xs text-ink-faint">
                  <RelativeTime iso={item.createdAt} />
                  {item.link && <Link href={item.link} className="link">Open</Link>}
                </p>
              </div>
              {!item.read && (
                <button type="button" className="btn-ghost btn-sm shrink-0 self-start" onClick={() => markRead(item.id)}>
                  Mark read
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
