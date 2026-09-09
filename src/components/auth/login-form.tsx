"use client";

import { useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, LockKeyhole, LogIn, Mail } from "lucide-react";
import { signInWithEmailAndPassword, signOut } from "firebase/auth";
import { getFirebaseClientAuth } from "@/lib/firebase/client";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { apiFetch, ClientApiError } from "@/lib/client/api";

type Method = "pass" | "firebase";

const METHOD_STORAGE_KEY = "gateway-login-method";

/** The remembered tab is client-only state read through a stable external store so the server and hydration render stay on the default. */
const emptySubscribe = () => () => {};
function readRememberedMethod(): Method {
  try {
    const stored = window.localStorage.getItem(METHOD_STORAGE_KEY);
    if (stored === "pass" || stored === "firebase") return stored;
  } catch { /* preference only */ }
  return "pass";
}

/** Only internal admin paths are honored so a crafted ?next= cannot redirect elsewhere. */
function destination(): string {
  const next = new URLSearchParams(window.location.search).get("next");
  if (next && next.startsWith("/admin/") && !next.startsWith("//")) return next;
  return "/admin/dashboard";
}

export function LoginForm() {
  const router = useRouter();
  const remembered = useSyncExternalStore(emptySubscribe, readRememberedMethod, (): Method => "pass");
  const [selected, setSelected] = useState<Method | null>(null);
  const method = selected ?? remembered;

  const [adminPass, setAdminPass] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [passBusy, setPassBusy] = useState(false);
  const [passError, setPassError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function switchMethod(next: Method) {
    setSelected(next);
    setPassError(null);
    setError(null);
    try { window.localStorage.setItem(METHOD_STORAGE_KEY, next); } catch { /* preference only */ }
  }

  async function onSubmitPass(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (passBusy) return;
    setPassBusy(true);
    setPassError(null);
    try {
      await apiFetch<{ actor: { role: string } }>("/api/auth/pass", { method: "POST", body: JSON.stringify({ adminPass }) });
      router.replace(destination());
    } catch (caught) {
      setPassError(caught instanceof ClientApiError ? caught.message : "We could not verify that passphrase. Try again.");
    } finally {
      setPassBusy(false);
    }
  }

  async function onSubmitFirebase(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const auth = getFirebaseClientAuth();
      const credential = await signInWithEmailAndPassword(auth, email.trim(), password);
      const token = await credential.user.getIdToken();
      await apiFetch("/api/auth/session", { method: "POST", body: JSON.stringify({ idToken: token }) });
      router.replace(destination());
    } catch (caught) {
      try { await signOut(getFirebaseClientAuth()); } catch { /* Firebase may not have initialized */ }
      if (caught instanceof ClientApiError) setError(caught.message);
      else setError("We could not sign you in with those details. Check your email and password, then try again.");
    } finally {
      setBusy(false);
    }
  }

  return <div className="space-y-5">
    <div className="grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1" role="tablist" aria-label="Sign-in method">
      <button type="button" role="tab" aria-selected={method === "pass"} onClick={() => switchMethod("pass")} className={`flex min-h-10 items-center justify-center gap-2 rounded-lg px-3 text-sm font-semibold transition ${method === "pass" ? "bg-white text-ink-900 shadow-sm" : "text-slate-500 hover:text-ink-900"}`}><KeyRound className="h-4 w-4" aria-hidden="true" />Shared passphrase</button>
      <button type="button" role="tab" aria-selected={method === "firebase"} onClick={() => switchMethod("firebase")} className={`flex min-h-10 items-center justify-center gap-2 rounded-lg px-3 text-sm font-semibold transition ${method === "firebase" ? "bg-white text-ink-900 shadow-sm" : "text-slate-500 hover:text-ink-900"}`}><Mail className="h-4 w-4" aria-hidden="true" />Email &amp; password</button>
    </div>

    {method === "pass" ? (
      <form className="space-y-5" onSubmit={onSubmitPass} noValidate>
        {passError && <Notice type="error">{passError}</Notice>}
        <div>
          <label className="field-label" htmlFor="adminPass">Shared passphrase</label>
          <div className="relative">
            <input id="adminPass" name="adminPass" type={showPass ? "text" : "password"} autoComplete="off" required value={adminPass} onChange={(event) => setAdminPass(event.target.value)} className="field-input pr-20" placeholder="Enter the shared access pass" disabled={passBusy} />
            <button type="button" className="absolute inset-y-0 right-2 px-2 text-xs font-bold text-ngo-700 hover:underline" onClick={() => setShowPass((value) => !value)}>{showPass ? "Hide" : "Show"}</button>
          </div>
        </div>
        <Button className="w-full" type="submit" disabled={passBusy}>{passBusy ? <><span className="h-4 w-4 animate-spin rounded-full border-2 border-white/50 border-t-white" />Signing in</> : <><KeyRound className="h-4 w-4" />Sign in</>}</Button>
        <p className="flex items-start gap-2 text-xs leading-5 text-slate-500"><LockKeyhole className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />The shared administrator passphrase signs you in directly with full administrator access. No separate account is needed.</p>
      </form>
    ) : (
      <form className="space-y-5" onSubmit={onSubmitFirebase} noValidate>
        {error && <Notice type="error">{error}</Notice>}
        <div>
          <label className="field-label" htmlFor="email">Email address</label>
          <input id="email" name="email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} className="field-input" placeholder="staff@example.org" disabled={busy} />
        </div>
        <div>
          <label className="field-label" htmlFor="password">Password</label>
          <div className="relative"><input id="password" name="password" type={showPassword ? "text" : "password"} autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} className="field-input pr-20" disabled={busy} /><button type="button" className="absolute inset-y-0 right-2 px-2 text-xs font-bold text-ngo-700 hover:underline" onClick={() => setShowPassword((value) => !value)}>{showPassword ? "Hide" : "Show"}</button></div>
        </div>
        <Button className="w-full" type="submit" disabled={busy}>{busy ? <><span className="h-4 w-4 animate-spin rounded-full border-2 border-white/50 border-t-white" />Signing in</> : <><LogIn className="h-4 w-4" />Sign in securely</>}</Button>
        <p className="flex items-start gap-2 text-xs leading-5 text-slate-500"><LockKeyhole className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />Use an account created for you in Firebase Authentication. Your session is verified server-side, and your assigned role decides what you can access.</p>
      </form>
    )}
  </div>;
}
