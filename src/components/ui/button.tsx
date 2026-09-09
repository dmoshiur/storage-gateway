import { forwardRef, type ButtonHTMLAttributes } from "react";
import { classNames } from "@/utils/format";

type Variant = "primary" | "secondary" | "danger" | "ghost";

const styles: Record<Variant, string> = {
  primary: "bg-ngo-600 text-white hover:bg-ngo-700 disabled:bg-ngo-300",
  secondary: "border border-slate-300 bg-white text-ink-700 hover:bg-slate-50 disabled:bg-slate-50",
  danger: "bg-red-700 text-white hover:bg-red-800 disabled:bg-red-300",
  ghost: "text-ink-700 hover:bg-slate-100 disabled:text-slate-400",
};

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }>(function Button(
  { className, variant = "primary", type = "button", ...props },
  ref,
) {
  return <button ref={ref} type={type} className={classNames("inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold transition disabled:cursor-not-allowed", styles[variant], className)} {...props} />;
});
