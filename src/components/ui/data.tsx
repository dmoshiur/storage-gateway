"use client";

import { useState, type ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight, Copy, Search, X } from "lucide-react";
import { useToast } from "@/components/providers";
import { formatRelative } from "@/utils/format";

export function CopyButton({ value, label = "Copy", className = "" }: { value: string; label?: string; className?: string }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        navigator.clipboard.writeText(value).then(
          () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          },
          () => toast("Copy failed. Select the text manually.", "error"),
        );
      }}
      className={`btn-icon h-7 w-7 ${className}`}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder = "Search…",
  shortcut,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  shortcut?: string;
  autoFocus?: boolean;
}) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
      <input
        type="search"
        role="searchbox"
        aria-label={placeholder}
        value={value}
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="field-input pl-9 pr-16 [&::-webkit-search-cancel-button]:hidden"
      />
      <span className="absolute right-2.5 top-1/2 flex -translate-y-1/2 items-center gap-1">
        {value && (
          <button type="button" aria-label="Clear search" onClick={() => onChange("")} className="rounded p-0.5 text-ink-faint hover:text-ink">
            <X className="h-3.5 w-3.5" />
          </button>
        )}
        {shortcut && <span className="kbd">{shortcut}</span>}
      </span>
    </div>
  );
}

export function Pagination({
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  label,
}: {
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  label?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-line bg-surface-raised px-3 py-2.5">
      <p className="text-xs text-ink-faint">{label ?? ""}</p>
      <div className="flex items-center gap-1.5">
        <button type="button" className="btn-secondary btn-sm" disabled={!hasPrev} onClick={onPrev}>
          <ChevronLeft className="h-3.5 w-3.5" /> Previous
        </button>
        <button type="button" className="btn-secondary btn-sm" disabled={!hasNext} onClick={onNext}>
          Next <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

export function Stat({ label, value, detail, icon }: { label: string; value: ReactNode; detail?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="card-pad">
      <div className="flex items-center justify-between gap-3">
        <p className="stat-label">{label}</p>
        {icon && <span className="text-ink-faint">{icon}</span>}
      </div>
      <p className="stat-value mt-2">{value}</p>
      {detail && <div className="mt-1.5 text-xs text-ink-muted">{detail}</div>}
    </div>
  );
}

export function UsageBar({ percent, tone = "default" }: { percent: number; tone?: "default" | "warning" | "critical" }) {
  const clamped = Math.min(100, Math.max(0, percent));
  const color = tone === "critical" ? "bg-red-500" : tone === "warning" ? "bg-amber-500" : "bg-slate-900 dark:bg-slate-100";
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-500/15" role="progressbar" aria-valuenow={Math.round(clamped)} aria-valuemin={0} aria-valuemax={100} aria-label="Storage usage">
      <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${clamped}%` }} />
    </div>
  );
}

export function Avatar({ name, size = "md" }: { name: string | null | undefined; size?: "sm" | "md" }) {
  const dims = size === "sm" ? "h-7 w-7 text-[11px]" : "h-9 w-9 text-xs";
  const text = (name ?? "?").trim();
  const letters = text.includes("@") ? text.slice(0, 2).toUpperCase() : text.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "?";
  return (
    <span className={`grid shrink-0 place-items-center rounded-full bg-slate-500/15 font-semibold text-ink ${dims}`} aria-hidden="true">
      {letters}
    </span>
  );
}

export function RelativeTime({ iso, className = "" }: { iso: string | null; className?: string }) {
  return (
    <time dateTime={iso ?? undefined} title={iso ? new Date(iso).toLocaleString() : undefined} className={className}>
      {formatRelative(iso)}
    </time>
  );
}

export function CodeBlock({ code, language }: { code: string; language?: string }) {
  const { toast } = useToast();
  return (
    <div className="group relative overflow-hidden rounded-lg border border-line bg-slate-950">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wider text-slate-400">{language ?? "http"}</span>
        <button
          type="button"
          className="rounded px-1.5 py-0.5 font-mono text-[11px] text-slate-400 hover:bg-white/10 hover:text-white"
          onClick={() => navigator.clipboard.writeText(code).then(() => toast("Copied to clipboard."), () => toast("Copy failed.", "error"))}
        >
          Copy
        </button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-[12.5px] leading-6 text-slate-100"><code>{code}</code></pre>
    </div>
  );
}
