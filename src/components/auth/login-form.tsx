"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, KeyRound, LockKeyhole, LogIn } from "lucide-react";
import { signInWithEmailAndPassword, signOut } from "firebase/auth";
import { getFirebaseClientAuth } from "@/lib/firebase/client";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { apiFetch, ClientApiError } from "@/lib/client/api";

type Step = "pass" | "firebase";

export function LoginForm() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("pass");

  const [adminPass, setAdminPass] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [gateBusy, setGateBusy] = useState(false);
  const [gateError, setGateError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmitGate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (gateBusy) return;
    setGateBusy(true);
    setGateError(null);
    try {
      await apiFetch<{ passphraseAccepted: boolean }>("/api/auth/gate", { method: "POST", body: JSON.stringify({ adminPass }) });
      setStep("firebase");
    } catch (caught) {
      setGateError(caught instanceof ClientApiError ? caught.message : "We could not verify that passphrase. Try again.");
    } finally {
      setGateBusy(false);
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
      router.replace("/admin/dashboard");
    } catch (caught) {
      try { await signOut(getFirebaseClientAuth()); } catch { /* Firebase may not have initialized */ }
      if (caught instanceof ClientApiError) setError(caught.message);
      else setError("We could not sign you in with those details. Check your email and password, then try again.");
    } finally {
      setBusy(false);
    }
  }

  if (step === "pass") {
    return (
      <form className="space-y-5" onSubmit={onSubmitGate} noValidate>
        {gateError && <Notice type="error">{gateError}</Notice>}
        <div>
          <label className="field-label" htmlFor="adminPass">Administrator passphrase</label>
          <div className="relative">
            <input id="adminPass" name="adminPass" type={showPass ? "text" : "password"} autoComplete="off" required value={adminPass} onChange={(event) => setAdminPass(event.target.value)} className="field-input pr-20" placeholder="Enter your access pass" disabled={gateBusy} />
            <button type="button" className="absolute inset-y-0 right-2 px-2 text-xs font-bold text-ngo-700 hover:underline" onClick={() => setShowPass((value) => !value)}>{showPass ? "Hide" : "Show"}</button>
          </div>
        </div>
        <Button className="w-full" type="submit" disabled={gateBusy}>{gateBusy ? <><span className="h-4 w-4 animate-spin rounded-full border-2 border-white/50 border-t-white" />Checking</> : <><KeyRound className="h-4 w-4" />Continue</>}</Button>
        <p className="flex items-start gap-2 text-xs leading-5 text-slate-500"><LockKeyhole className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />Access is restricted to authorized NGO administrators. Enter your shared passphrase to continue to secure sign-in.</p>
      </form>
    );
  }

  return (
    <form className="space-y-5" onSubmit={onSubmitFirebase} noValidate>
      <button type="button" className="inline-flex items-center gap-1.5 text-xs font-bold text-ngo-700 hover:underline" onClick={() => { setStep("pass"); setAdminPass(""); setGateError(null); }}><ArrowLeft className="h-3.5 w-3.5" />Use a different passphrase</button>
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
      <p className="flex items-start gap-2 text-xs leading-5 text-slate-500"><LockKeyhole className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />Your session is verified server-side before dashboard access is granted.</p>
    </form>
  );
}
