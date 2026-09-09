"use client";

import { useEffect, useState } from "react";
import { ChevronRight, ClipboardList, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice } from "@/components/ui/notice";
import { PageLoading } from "@/components/ui/loading";
import { apiFetch, ClientApiError } from "@/lib/client/api";
import type { SerializedAuditLog } from "@/types/audit";
import { formatDate } from "@/utils/format";

interface AuditResponse { logs: SerializedAuditLog[]; nextCursor: string | null; }
function fetchLogs(cursor?: string) {
  return apiFetch<AuditResponse>(`/api/audit-logs?pageSize=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
}

export function AuditLogList() {
  const [logs, setLogs] = useState<SerializedAuditLog[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load(next?: string) {
    setLoading(true);
    try {
      const data = await fetchLogs(next);
      setLogs(data.logs); setCursor(data.nextCursor); setError(null);
    } catch (caught) {
      setError(caught instanceof ClientApiError ? caught.message : "Audit logs could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let alive = true;
    fetchLogs().then((data) => {
      if (!alive) return;
      setLogs(data.logs); setCursor(data.nextCursor); setError(null);
    }).catch((caught) => {
      if (alive) setError(caught instanceof ClientApiError ? caught.message : "Audit logs could not be loaded.");
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  return <div className="space-y-6"><header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><p className="text-sm font-semibold uppercase tracking-wider text-ngo-600">Accountability</p><h1 className="mt-1 text-2xl font-bold tracking-tight text-ink-900 sm:text-3xl">Audit logs</h1><p className="mt-2 text-sm text-slate-600">Administrative activity is recorded without passwords, access tokens, or storage credentials.</p></div><Button variant="secondary" onClick={() => void load()} disabled={loading}><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />Refresh</Button></header>{error && <Notice type="error">{error}</Notice>}{loading && logs.length === 0 ? <PageLoading label="Loading audit records" /> : logs.length === 0 ? <EmptyState icon={ClipboardList} title="No audit activity yet" detail="Sign-ins, uploads, downloads, updates, cleanup activity, and settings changes will appear here." /> : <section className="panel overflow-hidden"><div className="hidden overflow-x-auto md:block"><table className="min-w-full divide-y divide-slate-200"><thead className="bg-slate-50"><tr><th className="table-heading px-4 py-3">Time</th><th className="table-heading px-4 py-3">Admin / source</th><th className="table-heading px-4 py-3">Action</th><th className="table-heading px-4 py-3">File</th><th className="table-heading px-4 py-3">Details</th></tr></thead><tbody className="divide-y divide-slate-100">{logs.map((log) => <tr key={log.id}><td className="whitespace-nowrap px-4 py-3.5 text-sm text-slate-600">{formatDate(log.createdAt, true)}</td><td className="px-4 py-3.5 text-sm text-slate-700">{log.actor.email ?? (log.actor.type === "system" ? "Scheduled cleanup" : "Website integration")}</td><td className="px-4 py-3.5"><span className="rounded bg-slate-100 px-2 py-1 font-mono text-xs font-bold text-ink-700">{log.action}</span></td><td className="max-w-xs truncate px-4 py-3.5 text-sm text-slate-700">{log.fileName ?? "—"}</td><td className="max-w-xs truncate px-4 py-3.5 text-xs text-slate-500">{log.details ? Object.entries(log.details).map(([key, value]) => `${key}: ${value}`).join(" · ") : "—"}</td></tr>)}</tbody></table></div><div className="divide-y divide-slate-100 md:hidden">{logs.map((log) => <article className="p-4" key={log.id}><p className="text-xs text-slate-500">{formatDate(log.createdAt, true)}</p><p className="mt-1 font-mono text-xs font-bold text-ink-700">{log.action}</p><p className="mt-2 text-sm font-semibold text-ink-900">{log.fileName ?? "Gateway activity"}</p><p className="mt-1 text-xs text-slate-600">{log.actor.email ?? (log.actor.type === "system" ? "Scheduled cleanup" : "Website integration")}</p></article>)}</div>{cursor && <div className="border-t border-slate-200 p-4 text-right"><Button variant="secondary" onClick={() => void load(cursor)} disabled={loading}>Load older activity<ChevronRight className="h-4 w-4" /></Button></div>}</section>}</div>;
}
