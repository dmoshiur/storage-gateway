"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { KeyRound, LoaderCircle } from "lucide-react";
import { useSearchParams, useRouter } from "next/navigation";
import { apiFetch, ClientApiError } from "@/lib/client/api";

function ResetForm() {
  const params = useSearchParams();
  const router = useRouter();
  const [token, setToken] = useState(params.get("token") ?? "");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (password !== confirmation) {
      setError("The passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await apiFetch("/api/auth/password/reset", { method: "POST", body: JSON.stringify({ token, newPassword: password }) });
      setMessage("Password reset successfully. You can sign in now.");
      window.setTimeout(() => router.push("/admin/login"), 900);
    } catch (caught) {
      setError(caught instanceof ClientApiError ? caught.message : "The password reset failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center bg-surface-sunken px-4 py-10">
      <div className="w-full max-w-[400px]">
        <div className="card p-6 sm:p-7">
          <div className="mb-5 flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"><KeyRound className="h-5 w-5" /></span><div><p className="text-[15px] font-semibold text-ink">Set a new password</p><p className="text-xs text-ink-muted">First-party account recovery</p></div></div>
          <form onSubmit={submit} className="space-y-4">
            <div><label className="field-label" htmlFor="reset-token">Reset token</label><input id="reset-token" required className="field-input font-mono text-xs" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Paste the one-time token" autoComplete="one-time-code" /></div>
            <div><label className="field-label" htmlFor="reset-password">New password</label><input id="reset-password" required minLength={12} type="password" className="field-input" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" /></div>
            <div><label className="field-label" htmlFor="reset-confirmation">Confirm new password</label><input id="reset-confirmation" required minLength={12} type="password" className="field-input" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" /></div>
            {error && <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
            {message && <p role="status" className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">{message}</p>}
            <button type="submit" disabled={busy || !token || password.length < 12 || password !== confirmation} className="btn-primary w-full">{busy && <LoaderCircle className="h-4 w-4 animate-spin" />}{busy ? "Resetting…" : "Reset password"}</button>
          </form>
          <Link href="/admin/login" className="mt-4 block text-center text-xs text-ink-muted hover:text-ink">Back to sign in</Link>
        </div>
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return <Suspense fallback={<div className="grid min-h-screen place-items-center"><LoaderCircle className="h-6 w-6 animate-spin text-ink-faint" /></div>}><ResetForm /></Suspense>;
}
