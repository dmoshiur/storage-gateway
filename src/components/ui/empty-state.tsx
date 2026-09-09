import type { LucideIcon } from "lucide-react";

export function EmptyState({ icon: Icon, title, detail, action }: { icon: LucideIcon; title: string; detail: string; action?: React.ReactNode }) {
  return <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center"><Icon className="mx-auto h-9 w-9 text-slate-400" aria-hidden="true" /><h3 className="mt-3 font-bold text-ink-900">{title}</h3><p className="mx-auto mt-1 max-w-md text-sm leading-6 text-slate-600">{detail}</p>{action && <div className="mt-4">{action}</div>}</div>;
}
