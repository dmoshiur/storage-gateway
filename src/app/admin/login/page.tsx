"use client";

import { Suspense, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signInWithEmailAndPassword, type AuthError } from "firebase/auth";
import { Database, KeyRound, LoaderCircle, Mail } from "lucide-react";
import { getFirebaseClientAuth, getFirebaseConfigStatus } from "@/lib/firebase/client";
import { apiFetch, ClientApiError } from "@/lib/client/api";

function mapFirebaseError(error: unknown): string {
  const code = (error as { code?: string })?.code ?? "";
  const message = error instanceof Error ? error.message : String(error);

  // Known Firebase Auth error codes.
  if (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found" || code === "auth/invalid-email") {
    return "Invalid email or password. Check your credentials and try again.";
  }
  if (code === "auth/user-disabled") {
    return "This account has been disabled. Contact an administrator.";
  }
  if (code === "auth/too-many-requests") {
    return "Too many failed attempts. Please wait a moment and try again.";
  }
  if (code === "auth/network-request-failed") {
    return "Network error contacting Firebase. Check your connection and try again.";
  }
  if (code === "auth/unauthorized-domain") {
    return "This domain is not authorized for Firebase Authentication. Add your production domain to Firebase Console → Authentication → Settings → Authorized domains.";
  }
  if (code === "auth/invalid-api-key" || code === "auth/api-key-not-valid.-please-pass-a-valid-api-key.") {
    return "Firebase API key is invalid. Verify NEXT_PUBLIC_FIREBASE_API_KEY in Vercel environment variables matches your Firebase project.";
  }
  if (code === "auth/project-not-found" || code === "auth/configuration-not-found") {
    return "Firebase project configuration not found. Verify NEXT_PUBLIC_FIREBASE_PROJECT_ID and other public Firebase env vars.";
  }
  // Fallback: if message contains auth/ pattern, treat as invalid credentials.
  if (/auth\//.test(code) || /auth\//.test(message)) {
    return `Firebase authentication failed (${code || "unknown"}). ${message.slice(0, 200)}`;
  }
  return message || "Sign-in failed.";
}

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
  const busyRef = useRef(false);
  const configStatus = getFirebaseConfigStatus();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      if (mode === "firebase") {
        if (!configStatus.configured) {
          throw new Error(
            `Firebase is not configured. Missing: ${configStatus.missing.join(", ")}. ` +
              "Set these in Vercel Project Settings → Environment Variables and redeploy.",
          );
        }
        const auth = getFirebaseClientAuth();
        const credential = await signInWithEmailAndPassword(auth, email.trim(), password);
        const idToken = await credential.user.getIdToken(true);
        await apiFetch("/api/auth/session", { method: "POST", body: JSON.stringify({ idToken }) });
      } else {
        await apiFetch("/api/auth/pass", { method: "POST", body: JSON.stringify({ adminPass }) });
      }
      router.push(next.startsWith("/admin") ? next : "/admin/overview");
      router.refresh();
    } catch (submitError) {
      if (submitError instanceof ClientApiError) {
        // Handle specific server errors with actionable messages.
        if (submitError.code === "SERVICE_CONFIGURATION_ERROR") {
          setError(
            `${submitError.message} Check Vercel environment variables and redeploy. ` +
              "If using Firebase, also verify your production domain is in Firebase Authorized domains.",
          );
        } else {
          setError(submitError.message);
        }
      } else if ((submitError as AuthError)?.code?.startsWith?.("auth/") || submitError instanceof Error) {
        setError(mapFirebaseError(submitError));
      } else {
        setError(submitError instanceof Error ? submitError.message : "Sign-in failed.");
      }
    } finally {
      busyRef.current = false;
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
        {!configStatus.configured && mode === "firebase" && (
          <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-200" role="alert">
            <p className="font-medium">Firebase not fully configured in this environment</p>
            <p className="mt-1 text-xs">Missing: {configStatus.missing.join(", ")}</p>
            <p className="mt-1 text-xs">Set these in Vercel → Settings → Environment Variables and redeploy. Also add your domain to Firebase Console → Auth → Authorized domains.</p>
          </div>
        )}
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
                    disabled={busy}
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
                    disabled={busy}
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
                  disabled={busy}
                />
                <p className="field-hint">Full administrator access. Rotating it signs out every shared session.</p>
              </div>
            )}
            {error && <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400 whitespace-pre-wrap break-words">{error}</p>}
            <button type="submit" disabled={busy} aria-busy={busy} className="btn-primary w-full">
              {busy && <LoaderCircle className="h-4 w-4 animate-spin" />}
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>
        <p className="mt-5 text-center font-mono text-[11px] text-ink-faint">NGO File Cloud · private access only</p>
        {configStatus.configured && (
          <p className="mt-2 text-center text-[11px] text-ink-faint">Project: {configStatus.projectId} · Domain: {configStatus.authDomain}</p>
        )}
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
