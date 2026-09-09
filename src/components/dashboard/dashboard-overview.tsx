"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Archive, ArrowRight, CalendarClock, FileText, HardDrive, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice } from "@/components/ui/notice";
import { PageLoading } from "@/components/ui/loading";
import { apiFetch, ClientApiError } from "@/lib/client/api";
import type { SerializedFile } from "@/types/file";
import { formatBytes, formatDate } from "@/utils/format";

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

export function DashboardOverview() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [recent, setRecent] = useState<SerializedFile[]>([]);
  const [trash, setTrash] = useState<SerializedFile[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([
      apiFetch<{ stats: Stats }>("/api/storage"),
      apiFetch<{ files: SerializedFile[] }>("/api/files?pageSize=6&status=active"),
      apiFetch<{ files: SerializedFile[] }>("/api/files?pageSize=4&status=trash"),
    ]).then(([storage, active, deleted]) => {
      if (!alive) return;
      setStats(storage.stats); setRecent(active.files); setTrash(deleted.files);
    }).catch((caught) => {
      if (alive) setError(caught instanceof ClientApiError ? caught.message : "Dashboard information is unavailable right now.");
    });
    return () => { alive = false; };
  }, []);

  if (error) return <Notice type="error">{error}</Notice>;
  if (!stats) return <PageLoading label="Loading storage overview" />;
  const critical = stats.warningLevel === "critical";
  const warning = stats.warningLevel === "warning";

  return <div className="space-y-6">
    <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><p className="text-sm font-semibold uppercase tracking-wider text-ngo-600">Overview</p><h1 className="mt-1 text-2xl font-bold tracking-tight text-ink-900 sm:text-3xl">Document storage dashboard</h1><p className="mt-2 text-sm text-slate-600">Private PDF records, retention, and recovery at a glance.</p></div><Link href="/admin/files" className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-ngo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-ngo-700"><Upload className="h-4 w-4" />Upload PDF</Link></header>

    {(warning || critical) && <Notice type={critical ? "error" : "warning"}><strong>{critical ? "Critical storage warning." : "Storage warning."}</strong> Storage usage is {stats.usagePercent}%. {critical ? "Free space or increase the approved storage limit soon." : "Consider reviewing unnecessary PDFs."}</Notice>}

    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Storage summary">
      <Metric icon={HardDrive} label="Storage" value={`${formatBytes(stats.totalStorageBytes)} / ${formatBytes(stats.storageLimitBytes)}`} detail={`${stats.usagePercent}% of configured limit`} />
      <Metric icon={FileText} label="Total PDFs" value={String(stats.totalPdfCount)} detail={`${stats.activeFileCount} active documents`} />
      <Metric icon={CalendarClock} label="Expiring soon" value={String(stats.expiringSoonCount)} detail="Within the next 30 days" />
      <Metric icon={Archive} label="Trash" value={String(stats.trashFileCount)} detail="Recoverable private documents" />
    </section>

    <section className="panel overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4"><div><h2 className="font-bold text-ink-900">Storage capacity</h2><p className="mt-0.5 text-sm text-slate-600">{formatBytes(stats.totalStorageBytes)} in use · {formatBytes(stats.availableBytes)} estimated available</p></div><Badge status={stats.warningLevel}>{stats.usagePercent}% used</Badge></div>
      <div className="p-5"><div className="h-3 overflow-hidden rounded-full bg-slate-100" aria-label={`${stats.usagePercent}% storage used`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={stats.usagePercent}><div className={critical ? "h-full rounded-full bg-red-700" : warning ? "h-full rounded-full bg-amber-500" : "h-full rounded-full bg-ngo-600"} style={{ width: `${Math.max(1, stats.usagePercent)}%` }} /></div><div className="mt-3 flex justify-between text-xs font-medium text-slate-500"><span>0 GB</span><span>Configured storage limit</span></div></div>
    </section>

    <section className="grid gap-6 xl:grid-cols-2">
      <ActivityList title="Recent uploads" href="/admin/files" files={recent} emptyTitle="No PDFs uploaded yet" emptyDetail="Upload the first private PDF record when you are ready." />
      <ActivityList title="Recently moved to Trash" href="/admin/trash" files={trash} trash emptyTitle="Trash is empty" emptyDetail="Deleted PDFs stay recoverable here until their scheduled permanent deletion." />
    </section>
  </div>;
}

function Metric({ icon: Icon, label, value, detail }: { icon: typeof FileText; label: string; value: string; detail: string }) {
  return <article className="panel p-4"><div className="flex items-start justify-between gap-3"><div><p className="text-sm font-semibold text-slate-600">{label}</p><p className="mt-2 text-2xl font-bold tracking-tight text-ink-900">{value}</p><p className="mt-1 text-xs text-slate-500">{detail}</p></div><span className="grid h-10 w-10 place-items-center rounded-xl bg-ngo-50 text-ngo-700"><Icon className="h-5 w-5" /></span></div></article>;
}

function ActivityList({ title, href, files, emptyTitle, emptyDetail, trash = false }: { title: string; href: string; files: SerializedFile[]; emptyTitle: string; emptyDetail: string; trash?: boolean }) {
  return <section className="panel overflow-hidden"><div className="flex items-center justify-between border-b border-slate-200 px-5 py-4"><h2 className="font-bold text-ink-900">{title}</h2><Link className="inline-flex items-center gap-1 text-sm font-semibold text-ngo-700 hover:underline" href={href}>View all <ArrowRight className="h-4 w-4" /></Link></div><div className="p-2">{files.length === 0 ? <EmptyState icon={trash ? Archive : FileText} title={emptyTitle} detail={emptyDetail} /> : <ul className="divide-y divide-slate-100">{files.map((file) => <li key={file.id} className="flex items-center gap-3 px-3 py-3"><span className={trash ? "grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-amber-50 text-amber-700" : "grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-ngo-50 text-ngo-700"}><FileText className="h-4 w-4" /></span><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-ink-900">{file.title || file.originalName}</p><p className="mt-0.5 truncate text-xs text-slate-500">{formatBytes(file.size)} · {formatDate(trash ? file.deletedAt : file.createdAt)}</p></div>{file.autoDeleteEnabled && !trash && <CalendarClock className="h-4 w-4 text-slate-400" aria-label="Auto-delete enabled" />}</li>)}</ul>}</div></section>;
}
