"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Activity, Archive, ArrowRight, CalendarClock, FileText, HardDrive, Radio, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice } from "@/components/ui/notice";
import { PageLoading } from "@/components/ui/loading";
import { apiFetch, ClientApiError } from "@/lib/client/api";
import type { SerializedFile } from "@/types/file";
import { classNames, formatBytes, formatDate } from "@/utils/format";

interface Stats {
  totalPdfCount: number;
  activeFileCount: number;
  trashFileCount: number;
  totalStorageBytes: number;
  storageLimitBytes: number;
  availableBytes: number;
  usagePercent: number;
  warningLevel: "normal" | "warning" | "critical";
  expiringSoonCount: number;
}

interface StorageHealth {
  reachable: boolean;
  latencyMs: number;
  checkedAt: string;
}

interface ApiRequestTotals {
  totalRequests: number;
  lastRequestDate: string | null;
}

interface StoragePayload {
  stats: Stats;
  source: "live" | "fallback";
  r2: StorageHealth;
  apiRequests: ApiRequestTotals;
}

interface HealthPayload {
  systemStatus: "operational" | "degraded";
  gateway: { runtime: string; uptimeSeconds: number; checkedAt: string };
  bridge: { configured: boolean; reachable: boolean; latencyMs: number; version: string | null; checkedAt: string; mode?: "embedded" | "external" };
}

function bridgeLabel(bridge: HealthPayload["bridge"]): string {
  return bridge.mode === "external" ? "External storage bridge" : "Storage bridge (embedded)";
}

interface UploadLog {
  id: string;
  keyId: string;
  filename: string;
  sizeBytes: number;
  status: "success" | "failed";
  failureCode: string | null;
  requestId: string;
  timestamp: string;
}

export function DashboardOverview() {
  const [payload, setPayload] = useState<StoragePayload | null>(null);
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [logs, setLogs] = useState<UploadLog[] | null>(null);
  const [recent, setRecent] = useState<SerializedFile[]>([]);
  const [trash, setTrash] = useState<SerializedFile[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    // Core metrics. The server degrades to fallback metrics instead of failing,
    // so a hard error here means an auth/transport problem, not Firestore.
    apiFetch<StoragePayload>("/api/storage")
      .then((data) => { if (alive) setPayload(data); })
      .catch((caught) => { if (alive) setError(caught instanceof ClientApiError ? caught.message : "Dashboard information is unavailable right now."); });
    // Widget data is fetched independently: one slow or failed widget must
    // never blank the rest of the dashboard.
    apiFetch<HealthPayload>("/api/health")
      .then((data) => { if (alive) setHealth(data); })
      .catch(() => { /* health badge stays in its neutral "checking" state */ });
    apiFetch<{ logs: UploadLog[] }>("/api/api-logs?limit=5")
      .then((data) => { if (alive) setLogs(data.logs); })
      .catch(() => { if (alive) setLogs([]); });
    Promise.all([
      apiFetch<{ files: SerializedFile[] }>(`/api/files?pageSize=6&status=active`),
      apiFetch<{ files: SerializedFile[] }>(`/api/files?pageSize=4&status=trash`),
    ])
      .then(([active, deleted]) => { if (alive) { setRecent(active.files); setTrash(deleted.files); } })
      .catch(() => { /* file lists render as empty states; metrics stay visible */ });
    return () => { alive = false; };
  }, []);

  if (error) return <Notice type="error">{error}</Notice>;
  if (!payload) return <PageLoading label="Loading storage overview" />;

  const stats = payload.stats;
  const r2Down = !payload.r2.reachable;
  const fallback = payload.source === "fallback" || r2Down;
  const critical = stats.warningLevel === "critical";
  const warning = stats.warningLevel === "warning";
  const operational = health?.systemStatus === "operational";

  return (
    <div className="space-y-6">
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wider text-ngo-600">Overview</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-ink-900 sm:text-3xl">Document storage dashboard</h1>
          <p className="mt-2 text-sm text-slate-600">Private documents, retention, and recovery at a glance.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <SystemStatusBadge health={health} />
          <Link href="/admin/files" className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-ngo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-ngo-700"><Upload className="h-4 w-4" />Upload document</Link>
        </div>
      </header>

      {fallback && (
        <Notice type="warning">
          <strong>Live storage data is temporarily unavailable.</strong>{" "}
          {payload.source === "fallback" ? "Firestore could not be reached, so " : ""}
          {r2Down ? "the Cloudflare R2 bucket check did not succeed, so " : ""}
          showing fallback metrics (0 files, 0 KB used) until the connection recovers. The dashboard itself is operational.
        </Notice>
      )}

      {(warning || critical) && !fallback && (
        <Notice type={critical ? "error" : "warning"}>
          <strong>{critical ? "Critical storage warning." : "Storage warning."}</strong> Storage usage is {stats.usagePercent}%. {critical ? "Free space or increase the approved storage limit soon." : "Consider reviewing unnecessary documents."}
        </Notice>
      )}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5" aria-label="Storage summary">
        <Metric icon={FileText} label="Total Documents Stored" value={String(stats.totalPdfCount)} detail={`${stats.activeFileCount} active documents`} />
        <Metric icon={HardDrive} label="Storage Space Used" value={`${formatBytes(stats.totalStorageBytes)} / ${formatBytes(stats.storageLimitBytes)}`} detail={r2Down ? "R2 check unavailable" : `${stats.usagePercent}% of R2 limit`} tone={r2Down ? "muted" : undefined} />
        <Metric icon={Activity} label="API Requests" value={payload.apiRequests.totalRequests.toLocaleString("en")} detail={payload.apiRequests.lastRequestDate ? `Last hit ${formatDate(payload.apiRequests.lastRequestDate)}` : "No gramunnayan.com traffic yet"} />
        <Metric icon={CalendarClock} label="Expiring soon" value={String(stats.expiringSoonCount)} detail="Within the next 30 days" />
        <Metric icon={Archive} label="Trash" value={String(stats.trashFileCount)} detail="Recoverable private documents" />
      </section>

      <section className="panel overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="font-bold text-ink-900">Storage capacity</h2>
            <p className="mt-0.5 text-sm text-slate-600">
              {formatBytes(stats.totalStorageBytes)} in use · {formatBytes(stats.availableBytes)} estimated available
              {payload.r2.reachable ? ` · R2 reachable (${payload.r2.latencyMs} ms)` : ""}
            </p>
          </div>
          <Badge status={r2Down ? "warning" : stats.warningLevel}>{r2Down ? "R2 unreachable" : `${stats.usagePercent}% used`}</Badge>
        </div>
        <div className="p-5">
          <div className="h-3 overflow-hidden rounded-full bg-slate-100" aria-label={`${stats.usagePercent}% storage used`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={stats.usagePercent}>
            <div className={critical ? "h-full rounded-full bg-red-700" : warning ? "h-full rounded-full bg-amber-500" : "h-full rounded-full bg-ngo-600"} style={{ width: `${Math.max(1, stats.usagePercent)}%` }} />
          </div>
          <div className="mt-3 flex justify-between text-xs font-medium text-slate-500">
            <span>0 GB</span><span>Configured storage limit (R2)</span>
          </div>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <ApiUploadLog logs={logs} />
        <ActivityList title="Recent uploads" href="/admin/files" files={recent} emptyTitle="No documents uploaded yet" emptyDetail="Upload the first private document when you are ready." />
      </section>

      <ActivityList title="Recently moved to Trash" href="/admin/trash" files={trash} trash emptyTitle="Trash is empty" emptyDetail="Deleted documents stay recoverable here until their scheduled permanent deletion." />

      {health && (
        <p className="text-xs text-slate-400">
          {operational
            ? `System Status: Operational · ${bridgeLabel(health.bridge)} reachable${health.bridge.version ? ` (v${health.bridge.version})` : ""}${health.bridge.mode === "external" ? ` in ${health.bridge.latencyMs} ms` : ""}`
            : `System Status: Degraded · ${bridgeLabel(health.bridge)} ${health.bridge.configured ? "is not responding" : "is not configured"} · checked ${formatDate(health.bridge.checkedAt, true)}`}
        </p>
      )}
    </div>
  );
}

function SystemStatusBadge({ health }: { health: HealthPayload | null }) {
  if (!health) {
    return (
      <span className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1.5 text-xs font-bold text-slate-600 ring-1 ring-inset ring-slate-200" role="status">
        <Radio className="h-3.5 w-3.5" aria-hidden="true" />Checking system status…
      </span>
    );
  }
  const operational = health.systemStatus === "operational";
  return (
    <span
      className={classNames(
        "inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-bold ring-1 ring-inset",
        operational ? "bg-ngo-50 text-ngo-700 ring-ngo-100" : "bg-amber-50 text-amber-800 ring-amber-200",
      )}
      role="status"
      title={
        operational
          ? health.bridge.mode === "external"
            ? `External storage bridge reachable in ${health.bridge.latencyMs} ms${health.bridge.version ? ` · v${health.bridge.version}` : ""}`
            : "Storage bridge runs embedded in this deployment."
          : health.bridge.configured
            ? "Storage bridge did not answer the health probe."
            : "No bridge configured for the health probe."
      }
    >
      <span className="relative flex h-2 w-2" aria-hidden="true">
        <span className={classNames("absolute inline-flex h-full w-full animate-ping rounded-full opacity-60", operational ? "bg-ngo-500" : "bg-amber-500")} />
        <span className={classNames("relative inline-flex h-2 w-2 rounded-full", operational ? "bg-ngo-600" : "bg-amber-600")} />
      </span>
      System Status: {operational ? "Operational" : "Degraded"}
    </span>
  );
}

function Metric({ icon: Icon, label, value, detail, tone }: { icon: typeof FileText; label: string; value: string; detail: string; tone?: "muted" }) {
  return (
    <article className="panel p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-600">{label}</p>
          <p className="mt-2 truncate text-2xl font-bold tracking-tight text-ink-900">{value}</p>
          <p className="mt-1 text-xs text-slate-500">{detail}</p>
        </div>
        <span className={tone === "muted" ? "grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-400" : "grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-ngo-50 text-ngo-700"}>
          <Icon className="h-5 w-5" />
        </span>
      </div>
    </article>
  );
}

/** Live log of the last 5 API (bridge) upload attempts from gramunnayan.com. */
function ApiUploadLog({ logs }: { logs: UploadLog[] | null }) {
  return (
    <section className="panel overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
        <div>
          <h2 className="font-bold text-ink-900">API Upload Activity</h2>
          <p className="mt-0.5 text-xs text-slate-500">Last 5 upload attempts from gramunnayan.com</p>
        </div>
        <Link className="inline-flex items-center gap-1 text-sm font-semibold text-ngo-700 hover:underline" href="/admin/api-management">
          API keys <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
      <div className="p-2">
        {logs === null ? (
          <PageLoading label="Loading API activity" />
        ) : logs.length === 0 ? (
          <EmptyState icon={Activity} title="No API uploads yet" detail="Successful and failed uploads from gramunnayan.com will appear here." />
        ) : (
          <ul className="divide-y divide-slate-100">
            {logs.map((log) => (
              <li key={log.id} className="flex items-center gap-3 px-3 py-3" title={log.failureCode ? `Failure code: ${log.failureCode}` : `Request ${log.requestId}`}>
                <span className={log.status === "success" ? "grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-ngo-50 text-ngo-700" : "grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-red-50 text-red-700"}>
                  <FileText className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-ink-900">{log.filename}</p>
                  <p className="mt-0.5 truncate text-xs text-slate-500">
                    {formatDate(log.timestamp, true)} · {formatBytes(log.sizeBytes)}
                    {log.keyId ? ` · ${log.keyId}` : ""}
                  </p>
                </div>
                <Badge status={log.status === "success" ? "active" : "failed"}>{log.status === "success" ? "Success" : "Failed"}</Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function ActivityList({ title, href, files, emptyTitle, emptyDetail, trash = false }: { title: string; href: string; files: SerializedFile[]; emptyTitle: string; emptyDetail: string; trash?: boolean }) {
  return (
    <section className="panel overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
        <h2 className="font-bold text-ink-900">{title}</h2>
        <Link className="inline-flex items-center gap-1 text-sm font-semibold text-ngo-700 hover:underline" href={href}>View all <ArrowRight className="h-4 w-4" /></Link>
      </div>
      <div className="p-2">
        {files.length === 0 ? (
          <EmptyState icon={trash ? Archive : FileText} title={emptyTitle} detail={emptyDetail} />
        ) : (
          <ul className="divide-y divide-slate-100">
            {files.map((file) => (
              <li key={file.id} className="flex items-center gap-3 px-3 py-3">
                <span className={trash ? "grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-amber-50 text-amber-700" : "grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-ngo-50 text-ngo-700"}>
                  <FileText className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-ink-900">{file.title || file.originalName}</p>
                  <p className="mt-0.5 truncate text-xs text-slate-500">{formatBytes(file.size)} · {formatDate(trash ? file.deletedAt : file.createdAt)}</p>
                </div>
                {file.autoDeleteEnabled && !trash && <CalendarClock className="h-4 w-4 text-slate-400" aria-label="Auto-delete enabled" />}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
