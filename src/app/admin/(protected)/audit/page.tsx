"use client";

import { useMemo, useState } from "react";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useQuery } from "@/hooks/use-query";
import { SearchInput, RelativeTime } from "@/components/ui/data";
import { ErrorState, EmptyState, TableSkeleton } from "@/components/ui/feedback";
import type { SerializedAuditLog } from "@/types/audit";

const ACTION_TONE: Record<string, string> = {
  LOGIN: "badge-success",
  LOGOUT: "badge-neutral",
  UPLOAD: "badge-info",
  BRIDGE_UPLOAD: "badge-info",
  DOWNLOAD: "badge-info",
  PREVIEW: "badge-neutral",
  MOVE_TO_TRASH: "badge-warning",
  RESTORE: "badge-success",
  PERMANENT_DELETE: "badge-danger",
  BULK_DELETE: "badge-danger",
  EMPTY_TRASH: "badge-danger",
  CLEANUP_FAILURE: "badge-danger",
  UPLOAD_FAILED: "badge-danger",
  LOGIN_FAILED: "badge-danger",
};

export default function AuditPage() {
  const [search, setSearch] = useState("");
  const [actionFilter, setActionFilter] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const debounced = useDebouncedValue(search);

  const { data, error, loading, refresh } = useQuery<{ logs: SerializedAuditLog[]; nextCursor: string | null }>(
    `/api/audit-logs?pageSize=50${cursor ? `&cursor=${cursor}` : ""}`,
  );

  const logs = useMemo(() => {
    const needle = debounced.trim().toLowerCase();
    return (data?.logs ?? []).filter((log) => {
      if (actionFilter && log.action !== actionFilter) return false;
      if (!needle) return true;
      return [log.action, log.actor.email ?? "", log.actor.uid, log.fileName ?? "", log.fileId ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [data, debounced, actionFilter]);

  const actions = useMemo(() => [...new Set((data?.logs ?? []).map((log) => log.action))].sort(), [data]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="page-title">Audit Logs</h1>
        <p className="page-sub">Immutable technical record of authentication, file, API, and settings events.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-full min-w-[200px] flex-1 sm:max-w-sm">
          <SearchInput value={search} onChange={(value) => { setSearch(value); setCursor(null); }} placeholder="Search action, user, file…" />
        </div>
        <select
          aria-label="Filter by action"
          className="field-input w-auto"
          value={actionFilter}
          onChange={(event) => { setActionFilter(event.target.value); setCursor(null); }}
        >
          <option value="">All actions</option>
          {actions.map((action) => (
            <option key={action} value={action}>{action}</option>
          ))}
        </select>
      </div>
      {loading && <TableSkeleton rows={10} columns={5} />}
      {error && !loading && <div className="tbl-wrap"><ErrorState message={error} onRetry={refresh} /></div>}
      {!loading && !error && logs.length === 0 && (
        <div className="tbl-wrap"><EmptyState title="No audit events" description="Events will appear here as the platform is used." /></div>
      )}
      {!loading && !error && logs.length > 0 && (
        <div className="tbl-wrap">
          <div className="overflow-x-auto">
            <table className="tbl min-w-[860px]">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Actor</th>
                  <th>Resource</th>
                  <th>Type</th>
                  <th>Timestamp</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id}>
                    <td><span className={ACTION_TONE[log.action] ?? "badge-neutral"}>{log.action}</span></td>
                    <td className="max-w-[220px] truncate text-[13px]" title={log.actor.email ?? log.actor.uid}>
                      {log.actor.email ?? log.actor.uid}
                    </td>
                    <td className="max-w-[240px] truncate font-mono text-xs text-ink-muted" title={log.fileName ?? log.fileId ?? ""}>
                      {log.fileName ?? log.fileId ?? "—"}
                    </td>
                    <td><span className="badge-neutral">{log.actor.type}</span></td>
                    <td className="whitespace-nowrap text-[13px] text-ink-muted">
                      <RelativeTime iso={log.createdAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t border-line px-3 py-2.5">
            <p className="text-xs text-ink-faint">{logs.length} event(s) shown</p>
            <div className="flex gap-1.5">
              {cursor && (
                <button type="button" className="btn-secondary btn-sm" onClick={() => setCursor(null)}>First page</button>
              )}
              <button type="button" className="btn-secondary btn-sm" disabled={!data?.nextCursor} onClick={() => setCursor(data?.nextCursor ?? null)}>
                Next page
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
