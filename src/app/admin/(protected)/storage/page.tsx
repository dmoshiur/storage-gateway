"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, LoaderCircle, ShieldAlert } from "lucide-react";
import { useQuery } from "@/hooks/use-query";
import { Stat, UsageBar, RelativeTime } from "@/components/ui/data";
import { CardsSkeleton, ErrorState } from "@/components/ui/feedback";
import { apiErrorOptions, apiFetch } from "@/lib/client/api";
import { useToast } from "@/components/providers";
import { formatBytes, formatNumber } from "@/utils/format";
import type { SerializedFile } from "@/types/file";

interface BlobVariableStatus {
  name: string;
  present: boolean;
  required: boolean;
  role: string;
  source: string;
  guidance: string;
}

interface BlobConfiguration {
  ok: boolean;
  authMode: "token" | "oidc" | "none";
  storeId: string | null;
  storeIdSource: string | null;
  oidcTokenInEnv: boolean;
  onVercel: boolean;
  vercelEnv: string | null;
  missing: string[];
  warnings: string[];
  variables: BlobVariableStatus[];
  hasReadWriteToken: boolean;
  hasWebhookPublicKey: boolean;
}

interface BlobHealth {
  reachable: boolean;
  configured?: boolean;
  latencyMs: number;
  checkedAt: string;
  error?: string | null;
  errorCode?: string | null;
  errorName?: string | null;
  hint?: string | null;
  authMode?: "token" | "oidc" | "none";
  storeId?: string | null;
  missingConfiguration?: string[];
  warnings?: string[];
  variables?: BlobVariableStatus[];
}

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
  };
  blob: BlobHealth;
  configuration: BlobConfiguration;
}

interface DeepCheckStep {
  step: string;
  ok: boolean;
  latencyMs: number;
  error?: string | null;
}

interface DeepCheckPayload {
  status: "healthy" | "degraded";
  probe: { steps: DeepCheckStep[]; cleanedUp: boolean; pathname: string | null };
  error: string | null;
  errorCode: string | null;
  errorName: string | null;
  hint: string | null;
}

function MissingConfiguration({ names }: { names: string[] }) {
  if (names.length === 0) return null;
  return (
    <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-800 dark:text-red-200" role="alert">
      <p className="font-medium">Missing configuration: {names.join(" + ")}</p>
      <p className="mt-1 text-[13px] leading-5">
        Connect the private Blob store to this Vercel project (Vercel → Storage → your store → Projects → Connect) so Vercel adds{" "}
        <code className="font-mono">BLOB_STORE_ID</code> and <code className="font-mono">BLOB_WEBHOOK_PUBLIC_KEY</code>, then redeploy.
        No filesystem or mock fallback is used.
      </p>
    </div>
  );
}

/**
 * Live Vercel Private Blob diagnostics. Shows the exact missing configuration
 * or the real Blob error instead of a generic "Blob unavailable" message, and
 * can run a real write → read → delete round-trip against the store.
 */
function BlobDiagnostics({ health, configuration }: { health: BlobHealth; configuration: BlobConfiguration }) {
  const { toast } = useToast();
  const [deep, setDeep] = useState<DeepCheckPayload | null>(null);
  const [running, setRunning] = useState(false);

  const runDeepCheck = async () => {
    setRunning(true);
    try {
      const result = await apiFetch<DeepCheckPayload>("/api/blob/health?deep=true");
      setDeep(result);
      if (result.status === "healthy") toast("Verbose Blob check passed: write, read and delete all succeeded.", "success");
      else toast(result.error ?? "The verbose Blob check failed.", "error");
    } catch (error) {
      const { message } = apiErrorOptions(error, "The verbose Blob check could not be run.");
      toast(message, "error");
    } finally {
      setRunning(false);
    }
  };

  const missing = configuration.missing.length > 0 ? configuration.missing : health.missingConfiguration ?? [];
  const warnings = health.warnings ?? configuration.warnings;

  return (
    <div className="card-pad">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="panel-title">Vercel Private Blob</h2>
          <p className="panel-sub">Authentication, project connection and live store probe.</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={health.reachable ? "badge-success" : "badge-danger"}>
            {health.reachable ? `Reachable · ${health.latencyMs} ms` : "Not reachable"}
          </span>
          <button type="button" className="btn-secondary btn-sm" onClick={runDeepCheck} disabled={running}>
            {running ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}
            {running ? "Running check…" : "Run verbose check"}
          </button>
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
        <div className="rounded-lg bg-surface-sunken p-3">
          <dt className="text-xs text-ink-muted">Auth mode</dt>
          <dd className="mt-1 font-semibold text-ink">{configuration.authMode === "none" ? "not configured" : configuration.authMode === "oidc" ? "Vercel OIDC" : "read-write token"}</dd>
        </div>
        <div className="rounded-lg bg-surface-sunken p-3">
          <dt className="text-xs text-ink-muted">Store id</dt>
          <dd className="mt-1 truncate font-mono text-xs font-semibold text-ink" title={configuration.storeId ?? undefined}>{configuration.storeId ?? "—"}</dd>
        </div>
        <div className="rounded-lg bg-surface-sunken p-3">
          <dt className="text-xs text-ink-muted">Environment</dt>
          <dd className="mt-1 font-semibold text-ink">{configuration.onVercel ? `Vercel · ${configuration.vercelEnv ?? "unknown"}` : "not Vercel"}</dd>
        </div>
        <div className="rounded-lg bg-surface-sunken p-3">
          <dt className="text-xs text-ink-muted">Checked</dt>
          <dd className="mt-1 font-semibold text-ink"><RelativeTime iso={health.checkedAt} /></dd>
        </div>
      </dl>

      {missing.length > 0 && <div className="mt-4"><MissingConfiguration names={missing} /></div>}

      {health.error && (
        <div className="mt-4 rounded-md border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-800 dark:text-red-200" role="alert">
          <p className="flex items-center gap-2 font-medium"><ShieldAlert className="h-4 w-4" /> Blob probe failed{health.errorCode ? ` · ${health.errorCode}` : ""}</p>
          <p className="mt-1 break-words font-mono text-xs leading-5">{health.error}</p>
          {health.hint && <p className="mt-1 text-[13px] leading-5">{health.hint}</p>}
        </div>
      )}

      {warnings.length > 0 && (
        <ul className="mt-4 space-y-2">
          {warnings.map((warning) => (
            <li key={warning} className="flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-[13px] text-amber-800 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{warning}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 overflow-x-auto">
        <table className="tbl text-[13px]">
          <thead>
            <tr>
              <th>Environment variable</th>
              <th>Status</th>
              <th>Required</th>
              <th>Provided by</th>
            </tr>
          </thead>
          <tbody>
            {configuration.variables.map((variable) => (
              <tr key={variable.name}>
                <td className="font-mono text-xs text-ink">{variable.name}</td>
                <td>{variable.present ? <span className="badge-success">set</span> : <span className={variable.required ? "badge-danger" : "badge-neutral"}>missing</span>}</td>
                <td className="text-ink-muted">{variable.required ? "yes" : variable.role === "webhook-verification" ? "for browser uploads" : "no"}</td>
                <td className="text-ink-muted">{variable.source === "runtime-request-header" ? "Vercel runtime (per request)" : "Vercel project / .env.local"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-ink-faint">Variable values are never read into the browser; only presence and the store id are shown.</p>

      {deep && (
        <div className="mt-4 rounded-lg border border-line p-3">
          <div className="flex items-center gap-2">
            {deep.status === "healthy" ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <ShieldAlert className="h-4 w-4 text-red-500" />}
            <p className="text-sm font-medium text-ink">Verbose check: write → read → delete</p>
          </div>
          <ul className="mt-2 space-y-1 font-mono text-xs text-ink-muted">
            {deep.probe.steps.map((step) => (
              <li key={step.step}>
                {step.ok ? "✓" : "✗"} {step.step} · {step.latencyMs} ms{step.error ? ` · ${step.error}` : ""}
              </li>
            ))}
          </ul>
          {deep.error && <p className="mt-2 break-words font-mono text-xs text-red-600 dark:text-red-400">{deep.error}</p>}
          {deep.hint && <p className="mt-1 text-[13px] text-ink-muted">{deep.hint}</p>}
        </div>
      )}
    </div>
  );
}

export default function StoragePage() {
  const storage = useQuery<StoragePayload>("/api/storage");
  const largest = useQuery<{ files: SerializedFile[] }>("/api/files?pageSize=8&status=active&filter=active&sort=largest");
  const recent = useQuery<{ files: SerializedFile[] }>("/api/files?pageSize=8&status=active&filter=active&sort=newest");

  if (storage.loading) {
    return (
      <div className="space-y-6">
        <div><h1 className="page-title">Storage</h1><p className="page-sub">Usage, growth, and largest documents.</p></div>
        <CardsSkeleton />
      </div>
    );
  }
  if (storage.error || !storage.data) {
    return (
      <div className="space-y-6">
        <div><h1 className="page-title">Storage</h1><p className="page-sub">Usage, growth, and largest documents.</p></div>
        <div className="tbl-wrap"><ErrorState message={storage.error ?? "Storage data unavailable."} onRetry={storage.refresh} /></div>
      </div>
    );
  }

  const stats = storage.data.stats;
  const avg = stats.activeFileCount > 0 ? stats.activeStorageBytes / stats.activeFileCount : 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">Storage</h1>
        <p className="page-sub">Usage, growth, and largest documents across the private Blob store.</p>
      </div>
      <div className="card-pad">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="panel-title">Storage overview</h2>
          {storage.data.blob.reachable
            ? <span className="badge-success">Blob store connected · {storage.data.blob.latencyMs} ms</span>
            : <span className="badge-danger">Blob store not reachable{storage.data.blob.errorCode ? ` · ${storage.data.blob.errorCode}` : ""}</span>}
        </div>
        <p className="tnum mt-3 text-3xl font-semibold tracking-tight text-ink">
          {formatBytes(stats.totalStorageBytes)} <span className="text-base font-normal text-ink-muted">/ {formatBytes(stats.storageLimitBytes)}</span>
        </p>
        <div className="mt-3"><UsageBar percent={stats.usagePercent} tone={stats.warningLevel === "normal" ? "default" : stats.warningLevel} /></div>
        <p className="tnum mt-2 text-[13px] text-ink-muted">{stats.usagePercent}% used · {formatBytes(stats.availableBytes)} available</p>
        {!storage.data.blob.reachable && storage.data.blob.error && (
          <p className="mt-3 break-words rounded-md border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-800 dark:text-red-200" role="alert">
            {storage.data.blob.error}
          </p>
        )}
      </div>

      <BlobDiagnostics health={storage.data.blob} configuration={storage.data.configuration} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Active files" value={formatNumber(stats.activeFileCount)} detail={`${formatBytes(stats.activeStorageBytes)} bytes`} />
        <Stat label="Average file size" value={formatBytes(avg)} detail="Across active documents" />
        <Stat label="Trash" value={formatBytes(stats.trashStorageBytes)} detail={`${formatNumber(stats.trashFileCount)} recoverable files`} />
        <Stat label="Expiring soon" value={formatNumber(stats.expiringSoonCount)} detail="Retention expires in 30 days" />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="card-pad">
          <h2 className="panel-title">Largest files</h2>
          <p className="panel-sub">Top documents by size.</p>
          <ul className="mt-3 divide-y divide-line">
            {(largest.data?.files ?? []).map((file) => (
              <li key={file.id} className="flex items-center justify-between gap-3 py-2.5 text-[13px]">
                <Link href={`/admin/files?preview=${file.id}`} className="min-w-0 flex-1 truncate font-medium text-ink hover:underline">
                  {file.title || file.originalName}
                </Link>
                <span className="tnum shrink-0 text-ink-muted">{formatBytes(file.size)}</span>
              </li>
            ))}
            {!largest.loading && (largest.data?.files.length ?? 0) === 0 && (
              <li className="py-4 text-center text-[13px] text-ink-faint">No files yet.</li>
            )}
          </ul>
        </div>
        <div className="card-pad">
          <h2 className="panel-title">Recent uploads</h2>
          <p className="panel-sub">Newest documents and when they arrived.</p>
          <ul className="mt-3 divide-y divide-line">
            {(recent.data?.files ?? []).map((file) => (
              <li key={file.id} className="flex items-center justify-between gap-3 py-2.5 text-[13px]">
                <Link href={`/admin/files?preview=${file.id}`} className="min-w-0 flex-1 truncate font-medium text-ink hover:underline">
                  {file.title || file.originalName}
                </Link>
                <RelativeTime iso={file.createdAt} className="shrink-0 text-xs text-ink-faint" />
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
