"use client";

import { Suspense, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Database, LoaderCircle, Mail, KeyRound } from "lucide-react";
import { apiFetch, ClientApiError } from "@/lib/client/api";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next")?.startsWith("/admin") ? params.get("next")! : "/admin/overview";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [resetMode, setResetMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      if (resetMode) {
        const result = await apiFetch<{ requested: boolean; resetToken?: string }>("/api/auth/password/request", { method: "POST", body: JSON.stringify({ email }) });
        setError(result.resetToken ? `Local reset token: ${result.resetToken}` : "If that account exists, your organization will deliver reset instructions.");
      } else {
        await apiFetch("/api/auth/session", { method: "POST", body: JSON.stringify({ email, password }) });
        router.push(next);
        router.refresh();
      }
    } catch (caught) {
      setError(caught instanceof ClientApiError ? caught.message : caught instanceof Error ? caught.message : "The request failed.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center bg-surface-sunken px-4 py-10">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"><Database className="h-5 w-5" /></span>
          <div><p className="text-[15px] font-semibold text-ink">NGO File Cloud</p><p className="text-xs text-ink-muted">Private document storage</p></div>
        </div>
        <div className="card p-6 sm:p-7">
          <h1 className="text-lg font-semibold tracking-tight text-ink">{resetMode ? "Reset your password" : "Sign in"}</h1>
          <p className="mt-1 text-sm text-ink-muted">{resetMode ? "Enter your account email to request a reset link." : "Access your organization&apos;s documents."}</p>
          <form onSubmit={submit} className="mt-5 space-y-4">
            <div><label className="field-label" htmlFor="login-email">Email</label><input id="login-email" type="email" autoComplete="email" required className="field-input" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@organization.org" disabled={busy} /></div>
            {!resetMode && <div><label className="field-label" htmlFor="login-password">Password</label><input id="login-password" type="password" autoComplete="current-password" required className="field-input" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Your password" disabled={busy} /></div>}
            {error && <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400 whitespace-pre-wrap break-words">{error}</p>}
            <button type="submit" disabled={busy} aria-busy={busy} className="btn-primary w-full">{busy && <LoaderCircle className="h-4 w-4 animate-spin" />}{busy ? "Working…" : resetMode ? "Request reset" : "Sign in"}</button>
          </form>
          <button type="button" className="mt-4 flex w-full items-center justify-center gap-1.5 text-xs text-ink-muted hover:text-ink" onClick={() => { setResetMode((value) => !value); setError(null); }}><KeyRound className="h-3.5 w-3.5" />{resetMode ? "Back to sign in" : "Forgot password?"}</button>
          {resetMode && <p className="mt-3 text-center text-xs text-ink-faint">Have a token? <Link href="/admin/reset-password" className="text-ink-muted underline hover:text-ink">Reset your password here</Link></p>}
        </div>
        <p className="mt-5 flex items-center justify-center gap-1 text-center font-mono text-[11px] text-ink-faint"><Mail className="h-3 w-3" /> First-party secure access</p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return <Suspense fallback={<div className="grid min-h-screen place-items-center"><LoaderCircle className="h-6 w-6 animate-spin text-ink-faint" /></div>}><LoginForm /></Suspense>;
}
