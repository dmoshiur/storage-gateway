"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signInWithEmailAndPassword } from "firebase/auth";
import { Database, KeyRound, LoaderCircle, Mail } from "lucide-react";
import { getFirebaseClientAuth } from "@/lib/firebase/client";
import { apiFetch, ClientApiError } from "@/lib/client/api";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") || "/admin/overview";
  const [mode, setMode] = useState<"firebase" | "pass">("firebase");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [adminPass, setAdminPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "firebase") {
        const credential = await signInWithEmailAndPassword(getFirebaseClientAuth(), email.trim(), password);
        const idToken = await credential.user.getIdToken();
        await apiFetch("/api/auth/session", { method: "POST", body: JSON.stringify({ idToken }) });
      } else {
        await apiFetch("/api/auth/pass", { method: "POST", body: JSON.stringify({ adminPass }) });
      }
      router.push(next.startsWith("/admin") ? next : "/admin/overview");
      router.refresh();
    } catch (submitError) {
      if (submitError instanceof ClientApiError) {
        setError(submitError.message);
      } else if (submitError instanceof Error && /auth\//.test(submitError.message)) {
        setError("Invalid email or password.");
      } else {
        setError(submitError instanceof Error ? submitError.message : "Sign-in failed.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center bg-surface-sunken px-4 py-10">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900">
            <Database className="h-5 w-5" />
          </span>
          <div>
            <p className="text-[15px] font-semibold text-ink">NGO File Cloud</p>
            <p className="text-xs text-ink-muted">Private document storage</p>
          </div>
        </div>
        <div className="card p-6 sm:p-7">
          <h1 className="text-lg font-semibold tracking-tight text-ink">Sign in</h1>
          <p className="mt-1 text-sm text-ink-muted">Access your organization&apos;s documents.</p>
          <div className="mt-5 grid grid-cols-2 gap-1 rounded-lg bg-surface-sunken p-1" role="tablist" aria-label="Sign-in method">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "firebase"}
              onClick={() => { setMode("firebase"); setError(null); }}
              className={`flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${mode === "firebase" ? "bg-surface-raised text-ink shadow-sm" : "text-ink-muted hover:text-ink"}`}
            >
              <Mail className="h-3.5 w-3.5" /> Email
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "pass"}
              onClick={() => { setMode("pass"); setError(null); }}
              className={`flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${mode === "pass" ? "bg-surface-raised text-ink shadow-sm" : "text-ink-muted hover:text-ink"}`}
            >
              <KeyRound className="h-3.5 w-3.5" /> Admin key
            </button>
          </div>
          <form onSubmit={submit} className="mt-5 space-y-4">
            {mode === "firebase" ? (
              <>
                <div>
                  <label className="field-label" htmlFor="login-email">Email</label>
                  <input
                    id="login-email"
                    type="email"
                    autoComplete="email"
                    required
                    className="field-input"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="you@organization.org"
                  />
                </div>
                <div>
                  <label className="field-label" htmlFor="login-password">Password</label>
                  <input
                    id="login-password"
                    type="password"
                    autoComplete="current-password"
                    required
                    className="field-input"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="••••••••"
                  />
                </div>
              </>
            ) : (
              <div>
                <label className="field-label" htmlFor="login-pass">Administrator passphrase</label>
                <input
                  id="login-pass"
                  type="password"
                  autoComplete="off"
                  required
                  className="field-input"
                  value={adminPass}
                  onChange={(event) => setAdminPass(event.target.value)}
                  placeholder="Shared administrator passphrase"
                />
                <p className="field-hint">Full administrator access. Rotating it signs out every shared session.</p>
              </div>
            )}
            {error && <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
            <button type="submit" disabled={busy} className="btn-primary w-full">
              {busy && <LoaderCircle className="h-4 w-4 animate-spin" />}
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>
        <p className="mt-5 text-center font-mono text-[11px] text-ink-faint">NGO File Cloud · private access only</p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="grid min-h-screen place-items-center"><LoaderCircle className="h-6 w-6 animate-spin text-ink-faint" /></div>}>
      <LoginForm />
    </Suspense>
  );
}
