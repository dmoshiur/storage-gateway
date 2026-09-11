"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Info, LoaderCircle, TriangleAlert, X, XCircle } from "lucide-react";
import { apiFetch } from "@/lib/client/api";
import { useOverlayBehavior } from "@/components/ui/overlays";
import type { Role } from "@/types/auth";

/* ---------------- theme ---------------- */

type Theme = "light" | "dark" | "system";

const ThemeContext = createContext<{ theme: Theme; resolved: "light" | "dark"; setTheme: (theme: Theme) => void }>({
  theme: "system",
  resolved: "light",
  setTheme: () => undefined,
});

export function useTheme() {
  return useContext(ThemeContext);
}

function applyTheme(theme: Theme): "light" | "dark" {
  const root = document.documentElement;
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const resolved = theme === "system" ? (prefersDark ? "dark" : "light") : theme;
  root.classList.toggle("dark", resolved === "dark");
  return resolved;
}

/* ---------------- toast ---------------- */

export type ToastTone = "success" | "error" | "warning" | "info" | "loading";

export interface ToastOptions {
  /** Request id shown with error toasts for production debugging. */
  requestId?: string;
  /** Optional retry handler rendered as a button on the toast. */
  retry?: () => void;
}

interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
  requestId?: string;
  retry?: () => void;
}

const ToastContext = createContext<{
  toast: (message: string, tone?: ToastTone, options?: ToastOptions) => number;
  dismiss: (id: number) => void;
}>({ toast: () => 0, dismiss: () => undefined });

export function useToast() {
  return useContext(ToastContext);
}

const TOAST_ICON: Record<ToastTone, typeof Info> = {
  success: CheckCircle2,
  error: XCircle,
  warning: TriangleAlert,
  info: Info,
  loading: LoaderCircle,
};

const TOAST_COLOR: Record<ToastTone, string> = {
  success: "text-emerald-500",
  error: "text-red-500",
  warning: "text-amber-500",
  info: "text-blue-500",
  loading: "text-ink-muted",
};

/* ---------------- confirm ---------------- */

interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  tone?: "danger" | "default";
  /** When set, the user must type this exact text to continue. */
  requireText?: string;
}

const ConfirmContext = createContext<(options: ConfirmOptions) => Promise<boolean>>(() => Promise.resolve(false));

export function useConfirm() {
  return useContext(ConfirmContext);
}

interface ConfirmState extends ConfirmOptions {
  resolve: (value: boolean) => void;
}

/* ---------------- session ---------------- */

export interface Session {
  uid: string;
  email: string | null;
  role: Role;
}

const SessionContext = createContext<{ session: Session | null; loading: boolean; refresh: () => void }>({
  session: null,
  loading: true,
  refresh: () => undefined,
});

export function useSession() {
  return useContext(SessionContext);
}

/* ---------------- confirm dialog (focus-managed) ---------------- */

function ConfirmDialog({ state, onResolve }: { state: ConfirmOptions; onResolve: (value: boolean) => void }) {
  const [input, setInput] = useState("");
  const confirmRef = useRef<HTMLButtonElement>(null);
  const panelRef = useOverlayBehavior({ onClose: () => onResolve(false) });
  const confirmed = Boolean(state.requireText && input === state.requireText);

  // Focus the confirmation control as soon as the dialog opens.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (state.requireText) panelRef.current?.querySelector<HTMLInputElement>("input")?.focus();
      else confirmRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [state.requireText, panelRef]);

  return (
    <div className="fixed inset-0 z-[90] grid place-items-center p-4" role="alertdialog" aria-modal="true" aria-label={state.title}>
      <div className="overlay" onClick={() => onResolve(false)} aria-hidden="true" />
      <div ref={panelRef} tabIndex={-1} className="dialog-panel relative z-10">
        <h2 className="text-[15px] font-semibold text-ink">{state.title}</h2>
        {state.description && <p className="mt-1.5 text-sm leading-6 text-ink-muted">{state.description}</p>}
        {state.requireText && (
          <label className="mt-4 block">
            <span className="field-label">Type <span className="mono font-semibold">{state.requireText}</span> to confirm</span>
            <input
              className="field-input mono"
              value={input}
              autoComplete="off"
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && confirmed) onResolve(true); }}
            />
          </label>
        )}
        <div className="mt-5 flex justify-end gap-2.5">
          <button type="button" className="btn-secondary" onClick={() => onResolve(false)}>Cancel</button>
          <button
            ref={confirmRef}
            type="button"
            disabled={Boolean(state.requireText && !confirmed)}
            className={state.tone === "danger" ? "btn-danger" : "btn-primary"}
            onClick={() => onResolve(true)}
          >
            {state.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- provider ---------------- */

export function Providers({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [theme, setThemeState] = useState<Theme>("system");
  const [resolved, setResolved] = useState<"light" | "dark">("light");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const toastId = useRef(0);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setResolved(applyTheme((localStorage.getItem("nfc-theme") as Theme | null) ?? "system"));
    media.addEventListener("change", onChange);
    // Deferred so state updates never run synchronously inside the effect.
    const timer = window.setTimeout(() => {
      const saved = localStorage.getItem("nfc-theme") as Theme | null;
      const initial = saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
      setThemeState(initial);
      setResolved(applyTheme(initial));
    }, 0);
    return () => {
      window.clearTimeout(timer);
      media.removeEventListener("change", onChange);
    };
  }, []);

  const setTheme = useCallback((next: Theme) => {
    localStorage.setItem("nfc-theme", next);
    setThemeState(next);
    setResolved(applyTheme(next));
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const toast = useCallback((message: string, tone: ToastTone = "success", options: ToastOptions = {}) => {
    toastId.current += 1;
    const id = toastId.current;
    setToasts((current) => [...current.slice(-3), { id, tone, message, requestId: options.requestId, retry: options.retry }]);
    if (tone !== "loading") {
      window.setTimeout(() => {
        setToasts((current) => current.filter((item) => item.id !== id));
      }, tone === "error" ? 9000 : 5000);
    }
    return id;
  }, []);

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => setConfirmState({ ...options, resolve }));
  }, []);

  const loadSession = useCallback(() => {
    setSessionLoading(true);
    apiFetch<{ actor: Session }>("/api/auth/me")
      .then((data) => setSession(data.actor))
      .catch((error) => {
        // Distinguish configuration errors (503) from auth failures (401).
        // 503 should not clear session as expired; it indicates server misconfiguration.
        const status = (error as { status?: number })?.status;
        const code = (error as { code?: string })?.code;
        if (status === 503 || code === "SERVICE_CONFIGURATION_ERROR") {
          console.error("Session check failed due to server configuration:", error);
          // Keep existing session if any, but don't treat as unauthenticated.
          // The server-side layout will handle 503 properly.
        } else {
          setSession(null);
        }
      })
      .finally(() => setSessionLoading(false));
  }, []);

  useEffect(() => {
    // Deferred so session state updates never run synchronously inside the effect.
    void Promise.resolve().then(() => loadSession());
    const onExpired = () => {
      setSession(null);
      router.push("/admin/login");
    };
    window.addEventListener("gateway-session-expired", onExpired);
    return () => window.removeEventListener("gateway-session-expired", onExpired);
  }, [loadSession, router]);

  const themeValue = useMemo(() => ({ theme, resolved, setTheme }), [theme, resolved, setTheme]);
  const toastValue = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);
  const sessionValue = useMemo(() => ({ session, loading: sessionLoading, refresh: loadSession }), [session, sessionLoading, loadSession]);

  return (
    <ThemeContext.Provider value={themeValue}>
      <ToastContext.Provider value={toastValue}>
        <ConfirmContext.Provider value={confirm}>
          <SessionContext.Provider value={sessionValue}>
            {children}
            {/* toasts */}
            <div aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2">
              {toasts.map((item) => {
                const Icon = TOAST_ICON[item.tone];
                return (
                  <div key={item.id} role="status" className="card pointer-events-auto flex items-start gap-2.5 p-3.5 shadow-pop animate-slide-up dark:shadow-popdark">
                    <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${TOAST_COLOR[item.tone]} ${item.tone === "loading" ? "animate-spin" : ""}`} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-medium leading-5 text-ink">{item.message}</p>
                      {item.requestId && (
                        <p className="mt-0.5 font-mono text-[11px] text-ink-faint">Request ID: {item.requestId}</p>
                      )}
                      {item.retry && item.tone === "error" && (
                        <button
                          type="button"
                          className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-red-500/10 px-2 py-1 text-xs font-semibold text-red-600 transition-colors hover:bg-red-500/20 dark:text-red-400"
                          onClick={() => { dismiss(item.id); item.retry?.(); }}
                        >
                          Retry
                        </button>
                      )}
                    </div>
                    <button type="button" aria-label="Dismiss notification" onClick={() => dismiss(item.id)} className="-mr-1 -mt-1 rounded-md p-1 text-ink-faint hover:text-ink">
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                );
              })}
            </div>
            {/* confirm dialog */}
            {confirmState && (
              <ConfirmDialog
                state={confirmState}
                onResolve={(value) => {
                  confirmState.resolve(value);
                  setConfirmState(null);
                }}
              />
            )}
          </SessionContext.Provider>
        </ConfirmContext.Provider>
      </ToastContext.Provider>
    </ThemeContext.Provider>
  );
}
