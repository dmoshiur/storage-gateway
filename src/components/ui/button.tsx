"use client";

import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Check, LoaderCircle } from "lucide-react";

export type AsyncStatus = "idle" | "loading" | "success" | "error";

interface AsyncButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> {
  onClick: () => Promise<unknown> | unknown;
  /** Label shown while the async handler is running. */
  loadingLabel?: string;
  /** Label shown briefly after a successful run. */
  successLabel?: string;
  children: ReactNode;
}

/**
 * A button with an explicit `idle → loading → success/error → idle` lifecycle
 * for a single async action. While running, only this button is disabled (it
 * never blocks the rest of the UI) and a spinner replaces its label, which
 * guarantees a double-click can never submit the same action twice.
 */
export function AsyncButton({
  onClick,
  loadingLabel,
  successLabel,
  disabled,
  children,
  className,
  ...rest
}: AsyncButtonProps) {
  const [status, setStatus] = useState<AsyncStatus>("idle");
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const run = async () => {
    if (status === "loading" || disabled) return;
    setStatus("loading");
    let nextStatus: AsyncStatus = "error";
    try {
      await onClick();
      nextStatus = "success";
    } catch {
      nextStatus = "error";
    } finally {
      if (mountedRef.current) setStatus(nextStatus);
      window.setTimeout(() => {
        if (mountedRef.current) setStatus("idle");
      }, nextStatus === "success" ? 1400 : 2200);
    }
  };

  const busy = status === "loading";

  return (
    <button
      type="button"
      {...rest}
      className={`${className ?? ""} ${status === "error" ? "ring-1 ring-red-500/60" : ""}`}
      disabled={disabled || busy}
      aria-busy={busy}
      onClick={run}
    >
      {busy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
      {status === "success" && <Check className="h-3.5 w-3.5" />}
      {busy ? (loadingLabel ?? children) : status === "success" ? (successLabel ?? children) : children}
    </button>
  );
}
