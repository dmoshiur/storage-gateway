"use client";

import { ShieldCheck } from "lucide-react";
import { useSession } from "@/components/providers";
import { useQuery } from "@/hooks/use-query";
import { RelativeTime } from "@/components/ui/data";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/ui/feedback";

interface Health { status: "healthy" | "degraded"; version: string; checkedAt: string; services: { application: { status: string }; database: { status: string; latencyMs: number; provider?: string; error?: string }; blobStorage: { status: string; latencyMs: number; authMode?: string | null; error?: string }; authentication: { status: string; provider: string }; scheduledCleanup: { status: string; lastRunAt: string | null; lastSummary: Record<string, number> | null; lastError: string | null } } }
function StatusRow({ label, status, detail }: { label: string; status: string; detail?: string }) { const healthy = status === "healthy"; return <li className="flex items-center justify-between gap-3 py-3"><div><p className="text-sm font-medium text-ink">{label}</p>{detail && <p className="tnum mt-0.5 font-mono text-xs text-ink-faint">{detail}</p>}</div><span className={healthy ? "badge-success" : "badge-danger"}><span className={`dot ${healthy ? "bg-emerald-500" : "bg-red-500"}`} /> {healthy ? "Healthy" : "Degraded"}</span></li>; }

export default function SystemPage() {
  const { session } = useSession();
  const { data, error, loading, refresh } = useQuery<Health>("/api/system/health", { refreshIntervalMs: 60000 });
  if (session && session.role !== "admin") return <div className="tbl-wrap"><EmptyState icon={<ShieldCheck className="h-6 w-6" />} title="Admins only" description="System health requires the administrator role." /></div>;
  return <div className="mx-auto max-w-3xl space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="page-title">System Health</h1><p className="page-sub">Live status of the first-party backend and private storage.</p></div><button type="button" className="btn-secondary btn-sm" onClick={refresh}>Refresh now</button></div>
    {loading && <TableSkeleton rows={5} columns={2} />}
    {error && !loading && <div className="tbl-wrap"><ErrorState message={error} onRetry={refresh} /></div>}
    {!loading && !error && data && <>
      <div className="card-pad"><div className="flex items-center justify-between gap-3"><h2 className="panel-title">Services</h2><span className={data.status === "healthy" ? "badge-success" : "badge-danger"}>{data.status === "healthy" ? "All systems operational" : "Degraded"}</span></div><ul className="mt-2 divide-y divide-line">
        <StatusRow label="Application" status={data.services.application.status} detail={`v${data.version}`} />
        <StatusRow label="PostgreSQL" status={data.services.database.status} detail={`${data.services.database.latencyMs} ms`} />
        <StatusRow label="Vercel Private Blob" status={data.services.blobStorage.status} detail={`${data.services.blobStorage.latencyMs} ms${data.services.blobStorage.authMode ? ` · ${data.services.blobStorage.authMode}` : ""}`} />
        <StatusRow label="Authentication" status={data.services.authentication.status} detail={data.services.authentication.provider} />
      </ul>{(data.services.database.error || data.services.blobStorage.error) && <div className="mt-4 space-y-2">{data.services.database.error && <p className="rounded-lg bg-red-500/10 px-3 py-2 font-mono text-xs text-red-600 dark:text-red-400">{data.services.database.error}</p>}{data.services.blobStorage.error && <p className="rounded-lg bg-red-500/10 px-3 py-2 font-mono text-xs text-red-600 dark:text-red-400">{data.services.blobStorage.error}</p>}</div>}</div>
      <div className="card-pad"><div className="flex items-center justify-between gap-3"><h2 className="panel-title">Scheduled cleanup</h2><span className={data.services.scheduledCleanup.status === "healthy" ? "badge-success" : "badge-danger"}>{data.services.scheduledCleanup.status === "healthy" ? "Healthy" : "Degraded"}</span></div><dl className="mt-3 space-y-2 text-[13px]"><div className="flex justify-between gap-3"><dt className="text-ink-muted">Last run</dt><dd className="font-medium text-ink"><RelativeTime iso={data.services.scheduledCleanup.lastRunAt} /></dd></div>{data.services.scheduledCleanup.lastSummary && <div className="flex justify-between gap-3"><dt className="text-ink-muted">Last summary</dt><dd className="tnum text-right font-mono text-xs text-ink">{Object.entries(data.services.scheduledCleanup.lastSummary).map(([key, value]) => `${key}: ${value}`).join(" · ")}</dd></div>}{data.services.scheduledCleanup.lastError && <div className="rounded-lg bg-red-500/10 px-3 py-2 text-red-600 dark:text-red-400">{data.services.scheduledCleanup.lastError}</div>}</dl></div>
      <p className="text-center font-mono text-[11px] text-ink-faint">Checked <RelativeTime iso={data.checkedAt} /> · no secrets are shown</p>
    </>}
  </div>;
}
