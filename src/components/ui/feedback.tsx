"use client";

import type { ReactNode } from "react";
import { FileQuestion, TriangleAlert } from "lucide-react";

export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z" />
    </svg>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-xl bg-slate-500/10 text-ink-faint">
        {icon ?? <FileQuestion className="h-6 w-6" />}
      </div>
      <h3 className="mt-4 text-[15px] font-semibold text-ink">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm leading-6 text-ink-muted">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export interface ErrorDetail {
  /** Public API error code, e.g. `FILES_FETCH_FAILED`. */
  code?: string | null;
  /** Server-side request id to quote in the logs. */
  requestId?: string | null;
}

export function ErrorState({
  message,
  onRetry,
  detail,
  busy,
}: {
  message: string;
  onRetry?: () => void;
  detail?: ErrorDetail | null;
  busy?: boolean;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-xl bg-red-500/10 text-red-500">
        <TriangleAlert className="h-6 w-6" />
      </div>
      <h3 className="mt-4 text-[15px] font-semibold text-ink">Something went wrong</h3>
      <p className="mt-1 max-w-sm text-sm leading-6 text-ink-muted">{message}</p>
      {(detail?.code || detail?.requestId) && (
        <p className="mt-2 font-mono text-[11px] text-ink-faint">
          {[detail.code, detail.requestId ? `request ${detail.requestId}` : null].filter(Boolean).join(" · ")}
        </p>
      )}
      {onRetry && (
        <button type="button" onClick={onRetry} disabled={busy} className="btn-secondary mt-5">
          {busy ? "Retrying…" : "Try again"}
        </button>
      )}
    </div>
  );
}

export function TableSkeleton({ rows = 6, columns = 6 }: { rows?: number; columns?: number }) {
  return (
    <div className="tbl-wrap" aria-hidden="true">
      <div className="border-b border-line bg-surface-sunken px-3 py-2.5">
        <div className="skeleton h-4 w-1/3" />
      </div>
      <div className="divide-y divide-line">
        {Array.from({ length: rows }).map((_, row) => (
          <div key={row} className="flex items-center gap-4 px-3 py-3.5">
            <div className="skeleton h-4 w-8" />
            <div className="skeleton h-4 flex-1" />
            {Array.from({ length: Math.max(1, columns - 2) }).map((_, col) => (
              <div key={col} className="skeleton hidden h-4 w-20 sm:block" />
            ))}
            <div className="skeleton h-4 w-10" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function CardsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-hidden="true">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="card-pad space-y-3">
          <div className="skeleton h-3 w-24" />
          <div className="skeleton h-7 w-32" />
          <div className="skeleton h-3 w-40" />
        </div>
      ))}
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div className="space-y-4" aria-hidden="true">
      <div className="skeleton h-8 w-56" />
      <div className="skeleton h-4 w-96" />
      <CardsSkeleton />
      <TableSkeleton />
    </div>
  );
}
