"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Info, LoaderCircle, TriangleAlert, X, XCircle } from "lucide-react";
import { apiFetch } from "@/lib/client/api";
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

interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

const ToastContext = createContext<{
  toast: (message: string, tone?: ToastTone) => number;
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

/* ---------------- provider ---------------- */

export function Providers({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [theme, setThemeState] = useState<Theme>("system");
  const [resolved, setResolved] = useState<"light" | "dark">("light");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirmState, setConfirmState] = useState<(ConfirmOptions & { resolve: (value: boolean) => void }) | null>(null);
  const [confirmInput, setConfirmInput] = useState("");
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

  const toast = useCallback((message: string, tone: ToastTone = "success") => {
    toastId.current += 1;
    const id = toastId.current;
    setToasts((current) => [...current.slice(-3), { id, tone, message }]);
    if (tone !== "loading") {
      window.setTimeout(() => {
        setToasts((current) => current.filter((item) => item.id !== id));
      }, tone === "error" ? 6000 : 4000);
    }
    return id;
  }, []);

  const confirm = useCallback((options: ConfirmOptions) => {
    setConfirmInput("");
    return new Promise<boolean>((resolve) => setConfirmState({ ...options, resolve }));
  }, []);

  const closeConfirm = useCallback((value: boolean) => {
    setConfirmState((current) => {
      current?.resolve(value);
      return null;
    });
  }, []);

  const loadSession = useCallback(() => {
    setSessionLoading(true);
    apiFetch<{ actor: Session }>("/api/auth/me")
      .then((data) => setSession(data.actor))
      .catch(() => setSession(null))
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
                    <p className="flex-1 text-[13px] font-medium leading-5 text-ink">{item.message}</p>
                    <button type="button" aria-label="Dismiss notification" onClick={() => dismiss(item.id)} className="-mr-1 -mt-1 rounded-md p-1 text-ink-faint hover:text-ink">
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                );
              })}
            </div>
            {/* confirm dialog */}
            {confirmState && (
              <div className="fixed inset-0 z-[90] grid place-items-center p-4" role="alertdialog" aria-modal="true" aria-label={confirmState.title}>
                <div className="overlay" onClick={() => closeConfirm(false)} />
                <div className="dialog-panel relative">
                  <h2 className="text-[15px] font-semibold text-ink">{confirmState.title}</h2>
                  {confirmState.description && <p className="mt-1.5 text-sm leading-6 text-ink-muted">{confirmState.description}</p>}
                  {confirmState.requireText && (
                    <label className="mt-4 block">
                      <span className="field-label">Type <span className="mono font-semibold">{confirmState.requireText}</span> to confirm</span>
                      <input
                        autoFocus
                        className="field-input mono"
                        value={confirmInput}
                        autoComplete="off"
                        onChange={(event) => setConfirmInput(event.target.value)}
                        onKeyDown={(event) => { if (event.key === "Enter" && confirmInput === confirmState.requireText) closeConfirm(true); }}
                      />
                    </label>
                  )}
                  <div className="mt-5 flex justify-end gap-2.5">
                    <button type="button" className="btn-secondary" onClick={() => closeConfirm(false)}>Cancel</button>
                    <button
                      type="button"
                      autoFocus={!confirmState.requireText}
                      disabled={Boolean(confirmState.requireText && confirmInput !== confirmState.requireText)}
                      className={confirmState.tone === "danger" ? "btn-danger" : "btn-primary"}
                      onClick={() => closeConfirm(true)}
                    >
                      {confirmState.confirmLabel ?? "Confirm"}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </SessionContext.Provider>
        </ConfirmContext.Provider>
      </ToastContext.Provider>
    </ThemeContext.Provider>
  );
}
