import { AlertCircle, CheckCircle2, Info } from "lucide-react";
import { classNames } from "@/utils/format";

export function Notice({ type = "info", children }: { type?: "info" | "success" | "error" | "warning"; children: React.ReactNode }) {
  const config = {
    info: { icon: Info, className: "border-blue-200 bg-blue-50 text-blue-900" },
    success: { icon: CheckCircle2, className: "border-ngo-100 bg-ngo-50 text-ngo-700" },
    error: { icon: AlertCircle, className: "border-red-200 bg-red-50 text-red-900" },
    warning: { icon: AlertCircle, className: "border-amber-200 bg-amber-50 text-amber-900" },
  }[type];
  const Icon = config.icon;
  return <div className={classNames("flex gap-3 rounded-xl border p-3.5 text-sm leading-5", config.className)} role={type === "error" ? "alert" : "status"}><Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" /><div>{children}</div></div>;
}
