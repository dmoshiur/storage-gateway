"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Archive, FileText, HardDrive, LoaderCircle, PlayCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { PageLoading } from "@/components/ui/loading";
import { apiFetch, ClientApiError } from "@/lib/client/api";
import { formatBytes } from "@/utils/format";

interface Stats { totalPdfCount: number; activeFileCount: number; trashFileCount: number; totalStorageBytes: number; storageLimitBytes: number; activeStorageBytes: number; trashStorageBytes: number; availableBytes: number; usagePercent: number; warningLevel: "normal" | "warning" | "critical"; expiringSoonCount: number; }
function fetchStats() { return apiFetch<{ stats: Stats }>("/api/storage"); }

export function StorageDetail() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cleanupMessage, setCleanupMessage] = useState<string | null>(null);

  async function load() {
    try { setError(null); const data = await fetchStats(); setStats(data.stats); }
    catch (caught) { setError(caught instanceof ClientApiError ? caught.message : "Storage statistics are unavailable."); }
  }

  useEffect(() => {
    let alive = true;
    fetchStats().then((data) => { if (alive) { setStats(data.stats); setError(null); } }).catch((caught) => {
      if (alive) setError(caught instanceof ClientApiError ? caught.message : "Storage statistics are unavailable.");
    });
    return () => { alive = false; };
  }, []);

  async function cleanup() {
    if (busy) return;
    setBusy(true); setCleanupMessage(null);
    try {
      const result = await apiFetch<{ checked: number; movedToTrash: number; permanentlyDeleted: number; failed: number; skipped: number; lockAcquired: boolean }>("/api/cleanup", { method: "POST", body: "{}" });
      setCleanupMessage(result.lockAcquired ? `Cleanup checked ${result.checked} record${result.checked === 1 ? "" : "s"}, moved ${result.movedToTrash} to Trash, permanently removed ${result.permanentlyDeleted}, and recorded ${result.failed} failure${result.failed === 1 ? "" : "s"}.` : "A scheduled cleanup is already running. No duplicate cleanup was started.");
      await load();
    } catch (caught) {
      setCleanupMessage(caught instanceof ClientApiError ? caught.message : "Cleanup could not be started.");
    } finally { setBusy(false); }
  }

  if (!stats && !error) return <PageLoading label="Calculating storage statistics" />;
  return <div className="space-y-6"><header><p className="text-sm font-semibold uppercase tracking-wider text-ngo-600">Capacity</p><h1 className="mt-1 text-2xl font-bold tracking-tight text-ink-900 sm:text-3xl">Storage health</h1><p className="mt-2 text-sm text-slate-600">Metadata-based capacity calculations include active documents and recoverable Trash objects.</p></header>{error && <Notice type="error">{error}</Notice>}{stats && <><section className="panel p-5 sm:p-6"><div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start"><div><h2 className="text-xl font-bold text-ink-900">{formatBytes(stats.totalStorageBytes)} / {formatBytes(stats.storageLimitBytes)}</h2><p className="mt-1 text-sm text-slate-600">{formatBytes(stats.availableBytes)} estimated available · {stats.usagePercent}% of the configured limit</p></div><span className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-bold ${stats.warningLevel === "critical" ? "bg-red-50 text-red-800" : stats.warningLevel === "warning" ? "bg-amber-50 text-amber-800" : "bg-ngo-50 text-ngo-700"}`}>{stats.warningLevel !== "normal" && <AlertTriangle className="h-4 w-4" />}{stats.warningLevel === "normal" ? "Capacity normal" : `${stats.warningLevel === "critical" ? "Critical" : "Warning"} threshold reached`}</span></div><div className="mt-6 h-4 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-label={`${stats.usagePercent}% storage used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={stats.usagePercent}><div className={stats.warningLevel === "critical" ? "h-full bg-red-700" : stats.warningLevel === "warning" ? "h-full bg-amber-500" : "h-full bg-ngo-600"} style={{ width: `${Math.max(stats.usagePercent, 1)}%` }} /></div></section><section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><Stat icon={FileText} label="All stored documents" value={String(stats.totalPdfCount)} /><Stat icon={HardDrive} label="Active documents" value={`${stats.activeFileCount} · ${formatBytes(stats.activeStorageBytes)}`} /><Stat icon={Archive} label="Recoverable Trash" value={`${stats.trashFileCount} · ${formatBytes(stats.trashStorageBytes)}`} /><Stat icon={AlertTriangle} label="Expiring in 30 days" value={String(stats.expiringSoonCount)} /></section></>}
    <section className="panel p-5 sm:p-6"><div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center"><div><h2 className="font-bold text-ink-900">Run secure cleanup</h2><p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">Cleanup is also scheduled daily. It uses a Firestore lock, handles each failure independently, and moves due files to Trash when safety mode is enabled.</p></div><Button onClick={cleanup} disabled={busy} className="shrink-0">{busy ? <><LoaderCircle className="h-4 w-4 animate-spin" />Running cleanup…</> : <><PlayCircle className="h-4 w-4" />Run cleanup now</>}</Button></div>{cleanupMessage && <div className="mt-4"><Notice type={cleanupMessage.includes("could not") ? "error" : "success"}>{cleanupMessage}</Notice></div>}</section></div>;
}
function Stat({ icon: Icon, label, value }: { icon: typeof FileText; label: string; value: string }) { return <article className="panel p-4"><Icon className="h-5 w-5 text-ngo-700" /><p className="mt-4 text-sm font-semibold text-slate-600">{label}</p><p className="mt-1 text-lg font-bold text-ink-900">{value}</p></article>; }
