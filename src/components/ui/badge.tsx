import { classNames } from "@/utils/format";

const tone = {
  active: "bg-ngo-50 text-ngo-700 ring-ngo-100",
  trash: "bg-amber-50 text-amber-800 ring-amber-100",
  deleted: "bg-slate-100 text-slate-700 ring-slate-200",
  uploading: "bg-blue-50 text-blue-700 ring-blue-100",
  deleting: "bg-orange-50 text-orange-800 ring-orange-100",
  failed: "bg-red-50 text-red-800 ring-red-100",
  normal: "bg-slate-100 text-slate-700 ring-slate-200",
  warning: "bg-amber-50 text-amber-800 ring-amber-100",
  critical: "bg-red-50 text-red-800 ring-red-100",
};

export function Badge({ children, status = "normal" }: { children: React.ReactNode; status?: keyof typeof tone }) {
  return <span className={classNames("inline-flex items-center rounded-full px-2.5 py-1 text-xs font-bold ring-1 ring-inset", tone[status])}>{children}</span>;
}
