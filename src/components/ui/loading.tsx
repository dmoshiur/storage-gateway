export function Spinner({ label = "Loading" }: { label?: string }) {
  return <span className="inline-flex items-center gap-2 text-sm text-slate-600" role="status"><span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-ngo-600" aria-hidden="true" />{label}<span className="sr-only">…</span></span>;
}

export function PageLoading({ label = "Loading information" }: { label?: string }) {
  return <div className="panel flex min-h-48 items-center justify-center p-6"><Spinner label={label} /></div>;
}
