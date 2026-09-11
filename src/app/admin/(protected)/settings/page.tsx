"use client";

import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { useSession, useToast } from "@/components/providers";
import { useQuery } from "@/hooks/use-query";
import { FirebaseConfigManager } from "@/components/settings/firebase-config-manager";
import { EmptyState, ErrorState, Spinner } from "@/components/ui/feedback";
import { apiFetch, ClientApiError } from "@/lib/client/api";
import type { SerializedSettings } from "@/types/settings";
import type { RetentionType } from "@/types/file";
import { RETENTION_OPTIONS } from "@/components/files/metadata-modal";

const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

function NumberField({ id, label, hint, value, min, max, step, unit, onChange }: {
  id: string;
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <label className="field-label" htmlFor={id}>{label}</label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="number"
          className="field-input max-w-40"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <span className="text-[13px] text-ink-muted">{unit}</span>
      </div>
      <p className="field-hint">{hint}</p>
    </div>
  );
}

function Toggle({ id, label, hint, checked, onChange }: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-line p-3.5">
      <div>
        <label className="text-sm font-medium text-ink" htmlFor={id}>{label}</label>
        <p className="mt-0.5 text-[13px] text-ink-muted">{hint}</p>
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? "bg-slate-900 dark:bg-slate-100" : "bg-slate-300 dark:bg-slate-700"}`}
      >
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all dark:bg-slate-900 ${checked ? "left-[22px]" : "left-0.5"}`} />
      </button>
    </div>
  );
}

export default function SettingsPage() {
  const { session } = useSession();
  const { toast } = useToast();
  const { data, error, loading, refresh } = useQuery<{ settings: SerializedSettings }>("/api/settings");
  const [form, setForm] = useState<SerializedSettings | null>(null);
  const [applyToExisting, setApplyToExisting] = useState(false);
  const [saving, setSaving] = useState(false);

  // Sync the form when freshly loaded settings arrive (render-adjust, not an effect).
  const [formKey, setFormKey] = useState<string | null>(null);
  const settingsKey = data ? data.settings.updatedAt ?? "defaults" : null;
  if (settingsKey !== formKey) {
    setFormKey(settingsKey);
    setForm(data?.settings ?? null);
  }

  if (session && session.role !== "admin") {
    return (
      <div className="tbl-wrap">
        <EmptyState icon={<ShieldCheck className="h-6 w-6" />} title="Admins only" description="Platform settings require the administrator role." />
      </div>
    );
  }

  const set = <K extends keyof SerializedSettings>(key: K, value: SerializedSettings[K]) => {
    setForm((current) => (current ? { ...current, [key]: value } : current));
  };

  const save = async () => {
    if (!form) return;
    if (form.warningThresholdPercent >= form.criticalThresholdPercent) {
      toast("Critical threshold must be higher than the warning threshold.", "error");
      return;
    }
    setSaving(true);
    try {
      const result = await apiFetch<{ settings: SerializedSettings; updatedFiles: number }>("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ ...form, updatedAt: undefined, updatedBy: undefined, applyToExisting }),
      });
      setForm(result.settings);
      toast(applyToExisting ? `Settings saved. ${result.updatedFiles} files updated.` : "Settings saved.");
      refresh();
    } catch (saveError) {
      toast(saveError instanceof ClientApiError ? saveError.message : "Save failed.", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <h1 className="page-title">Settings</h1>
        <p className="page-sub">Firebase configuration, storage limits, retention defaults, and signed-URL behavior.</p>
      </div>
      <FirebaseConfigManager />
      {loading && (
        <div className="card-pad space-y-3" aria-label="Loading settings">
          <div className="skeleton h-6 w-40" />
          <div className="skeleton h-20 w-full" />
          <div className="skeleton h-20 w-full" />
        </div>
      )}
      {error && !loading && <div className="tbl-wrap"><ErrorState message={error} onRetry={refresh} /></div>}
      {!loading && !error && form && (
        <>
          <div className="card-pad space-y-5">
            <h2 className="section-title">Storage limits</h2>
            <NumberField
              id="set-max-pdf" label="Maximum PDF size" hint="Largest single file accepted (1 MB – 500 MB)."
              value={Math.round(form.maxPdfSizeBytes / MB)} min={1} max={500} step={1} unit="MB"
              onChange={(value) => set("maxPdfSizeBytes", Math.round(value * MB))}
            />
            <NumberField
              id="set-quota" label="Organization storage quota" hint="Total bytes across all documents (1 GB – 1 TB)."
              value={Math.round((form.storageLimitBytes / GB) * 10) / 10} min={1} max={1024} step={1} unit="GB"
              onChange={(value) => set("storageLimitBytes", Math.round(value * GB))}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <NumberField
                id="set-warn" label="Warning threshold" hint="Notify at this usage."
                value={form.warningThresholdPercent} min={1} max={98} step={1} unit="%"
                onChange={(value) => set("warningThresholdPercent", Math.round(value))}
              />
              <NumberField
                id="set-crit" label="Critical threshold" hint="Urgent alert at this usage."
                value={form.criticalThresholdPercent} min={2} max={99} step={1} unit="%"
                onChange={(value) => set("criticalThresholdPercent", Math.round(value))}
              />
            </div>
          </div>

          <div className="card-pad space-y-4">
            <h2 className="section-title">Retention defaults</h2>
            <Toggle
              id="set-autodel" label="Auto-delete new uploads" hint="New documents get an automatic deletion date unless changed."
              checked={form.defaultAutoDelete} onChange={(value) => set("defaultAutoDelete", value)}
            />
            <div>
              <label className="field-label" htmlFor="set-retention">Default retention period</label>
              <select
                id="set-retention"
                className="field-input"
                value={form.defaultRetentionType}
                onChange={(event) => set("defaultRetentionType", event.target.value as Exclude<RetentionType, "custom_date">)}
              >
                {RETENTION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
            <Toggle
              id="set-trash" label="Trash enabled" hint="Deleted documents go to Trash first and can be restored."
              checked={form.trashEnabled} onChange={(value) => set("trashEnabled", value)}
            />
            <NumberField
              id="set-trash-days" label="Trash retention" hint="Trashed documents are destroyed after this long (1 – 365 days)."
              value={form.trashRetentionDays} min={1} max={365} step={1} unit="days"
              onChange={(value) => set("trashRetentionDays", Math.round(value))}
            />
            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line p-3.5">
              <input type="checkbox" className="field-check mt-0.5" checked={applyToExisting} onChange={(event) => setApplyToExisting(event.target.checked)} />
              <span>
                <span className="text-sm font-medium text-ink">Apply retention defaults to existing files</span>
                <span className="block text-[13px] text-ink-muted">Updates auto-delete and retention on every active document without a custom policy.</span>
              </span>
            </label>
          </div>

          <div className="card-pad space-y-4">
            <h2 className="section-title">Security</h2>
            <NumberField
              id="set-ttl" label="Signed URL lifetime" hint="How long preview/download links stay valid (1 – 60 minutes)."
              value={Math.round(form.signedUrlExpirySeconds / 60)} min={1} max={60} step={1} unit="minutes"
              onChange={(value) => set("signedUrlExpirySeconds", Math.round(value * 60))}
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-ink-faint">
              {form.updatedBy ? `Last changed by ${form.updatedBy}` : "Defaults"} {form.updatedAt ? `· ${new Date(form.updatedAt).toLocaleString()}` : ""}
            </p>
            <button type="button" className="btn-primary" onClick={save} disabled={saving}>
              {saving && <Spinner />} Save settings
            </button>
          </div>
        </>
      )}
    </div>
  );
}
