"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogIn, LockKeyhole } from "lucide-react";
import { signInWithEmailAndPassword, signOut } from "firebase/auth";
import { getFirebaseClientAuth } from "@/lib/firebase/client";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { apiFetch, ClientApiError } from "@/lib/client/api";

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const auth = getFirebaseClientAuth();
      const credential = await signInWithEmailAndPassword(auth, email.trim(), password);
      const token = await credential.user.getIdToken();
      await apiFetch("/api/auth/session", { method: "POST", body: JSON.stringify({ idToken: token }) });
      router.replace("/admin/dashboard");
    } catch (caught) {
      try { await signOut(getFirebaseClientAuth()); } catch { /* Firebase may not have initialized */ }
      if (caught instanceof ClientApiError) setError(caught.message);
      else setError("We could not sign you in with those details. Check your email and password, then try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="space-y-5" onSubmit={onSubmit} noValidate>
      {error && <Notice type="error">{error}</Notice>}
      <div>
        <label className="field-label" htmlFor="email">Email address</label>
        <input id="email" name="email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} className="field-input" placeholder="admin@example.org" disabled={busy} />
      </div>
      <div>
        <label className="field-label" htmlFor="password">Password</label>
        <div className="relative"><input id="password" name="password" type={showPassword ? "text" : "password"} autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} className="field-input pr-20" disabled={busy} /><button type="button" className="absolute inset-y-0 right-2 px-2 text-xs font-bold text-ngo-700 hover:underline" onClick={() => setShowPassword((value) => !value)}>{showPassword ? "Hide" : "Show"}</button></div>
      </div>
      <Button className="w-full" type="submit" disabled={busy}>{busy ? <><span className="h-4 w-4 animate-spin rounded-full border-2 border-white/50 border-t-white" />Signing in</> : <><LogIn className="h-4 w-4" />Sign in securely</>}</Button>
      <p className="flex items-start gap-2 text-xs leading-5 text-slate-500"><LockKeyhole className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />Access is restricted to authorized NGO administrators. Your session is verified server-side.</p>
    </form>
  );
}
