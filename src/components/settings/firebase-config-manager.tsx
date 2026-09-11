"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  FlaskConical,
  KeyRound,
  RotateCcw,
  Save,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { useConfirm, useToast } from "@/components/providers";
import { useQuery } from "@/hooks/use-query";
import { ErrorState, Spinner } from "@/components/ui/feedback";
import { apiFetch, ClientApiError } from "@/lib/client/api";
import {
  FIREBASE_CONFIG_EXAMPLE,
  KNOWN_FIREBASE_FIELDS,
  OPTIONAL_FIREBASE_FIELDS,
  REQUIRED_FIREBASE_FIELDS,
  maskFirebaseValue,
  parseFirebaseWebConfigJson,
  type FirebaseRuntimeStatus,
  type FirebaseWebConfig,
} from "@/lib/firebase/web-config";
import {
  applyFirebaseWebConfig,
  clearFirebaseDefaultApp,
  fetchFirebaseRuntimeStatus,
  resetFirebaseRuntimeCache,
} from "@/lib/firebase/client";
import { probeFirebaseWebConfigClient, signInToCandidateProject } from "@/lib/firebase/client-probe";
import type { ProbeReport, ProbeStep } from "@/lib/firebase/probe-shared";

function StepRow({ step }: { step: ProbeStep }) {
  const icon =
    step.status === "passed" ? (
      <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
    ) : step.status === "failed" ? (
      <XCircle className="h-4 w-4 shrink-0 text-red-500" />
    ) : step.status === "warning" ? (
      <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
    ) : (
      <span className="grid h-4 w-4 shrink-0 place-items-center text-[11px] text-ink-faint">–</span>
    );
  return (
    <li className="flex items-start gap-2.5 py-2.5">
      <span className="mt-0.5">{icon}</span>
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-ink">
          {step.label}
          <span className="tnum ml-2 font-mono text-[11px] font-normal text-ink-faint">{step.latencyMs} ms</span>
        </p>
        <p className="mt-0.5 text-[13px] leading-5 text-ink-muted">{step.message}</p>
      </div>
    </li>
  );
}

function ReportBlock({ title, hint, report }: { title: string; hint: string; report: ProbeReport | null }) {
  if (!report) return null;
  return (
    <div className="rounded-lg border border-line p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-ink">{title}</p>
          <p className="text-xs text-ink-muted">{hint}</p>
        </div>
        <span className={report.ok ? "badge-success" : "badge-danger"}>
          <span className={`dot ${report.ok ? "bg-emerald-500" : "bg-red-500"}`} />
          {report.ok ? "Connected" : "Failed"}
        </span>
      </div>
      <p className="mt-2 rounded-md bg-surface-sunken px-2.5 py-2 text-[13px] leading-5 text-ink-muted">{report.summary}</p>
      <ul className="mt-1 divide-y divide-line">
        {report.steps.map((step) => (
          <StepRow key={`${title}-${step.id}`} step={step} />
        ))}
      </ul>
      <p className="mt-1 font-mono text-[11px] text-ink-faint">
        Checked {new Date(report.checkedAt).toLocaleString()} · {report.latencyMs} ms total
      </p>
    </div>
  );
}

export function FirebaseConfigManager() {
  const { toast } = useToast();
  const confirm = useConfirm();
  const { data: status, error, loading, refresh } = useQuery<FirebaseRuntimeStatus>("/api/firebase-config");
  const [raw, setRaw] = useState("");
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [clientReport, setClientReport] = useState<ProbeReport | null>(null);
  const [serverReport, setServerReport] = useState<ProbeReport | null>(null);
  const [testedLabel, setTestedLabel] = useState<string | null>(null);
  const [verifyEmail, setVerifyEmail] = useState("");
  const [verifyPassword, setVerifyPassword] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{ uid: string; email: string | null; role: string; projectId: string } | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const parsed = useMemo(() => (raw.trim() ? parseFirebaseWebConfigJson(raw) : null), [raw]);
  const busy = testing || saving || resetting;

  /** The config under test: pasted JSON wins, otherwise the effective config. */
  const candidate: FirebaseWebConfig | null = parsed?.config ?? status?.config ?? null;
  const candidateLabel = parsed?.config
    ? `pasted JSON (project “${parsed.config.projectId}”)`
    : status?.config
      ? `current ${status.source === "stored" ? "managed" : "environment"} config (project “${status.config.projectId}”)`
      : null;

  const overall: { tone: "idle" | "ok" | "bad"; label: string } = (() => {
    if (!serverReport && !clientReport) {
      if (status && !status.configured) return { tone: "bad", label: "Not configured" };
      return { tone: "idle", label: "Not tested yet" };
    }
    const reports = [serverReport, clientReport].filter((report): report is ProbeReport => report !== null);
    return reports.every((report) => report.ok)
      ? { tone: "ok", label: "Connected" }
      : { tone: "bad", label: "Failed" };
  })();

  const runTests = async (config: FirebaseWebConfig, label: string): Promise<{ server: ProbeReport | null; client: ProbeReport | null }> => {
    const [serverSettled, clientSettled] = await Promise.allSettled([
      apiFetch<ProbeReport>("/api/firebase-config/test", { method: "POST", body: JSON.stringify({ config }) }),
      probeFirebaseWebConfigClient(config),
    ]);
    const server = serverSettled.status === "fulfilled" ? serverSettled.value : null;
    const client = clientSettled.status === "fulfilled" ? clientSettled.value : null;
    if (serverSettled.status === "rejected" && !(serverSettled.reason instanceof ClientApiError && serverSettled.reason.code === "VALIDATION_ERROR")) {
      const reason = serverSettled.reason;
      const message = reason instanceof ClientApiError ? reason.message : "Server test failed.";
      toast(message, "error", { requestId: reason instanceof ClientApiError ? reason.requestId ?? undefined : undefined });
    }
    setServerReport(server);
    setClientReport(client);
    setTestedLabel(label);
    return { server, client };
  };

  const testConnection = async () => {
    if (!candidate || !candidateLabel) {
      toast("Nothing to test: paste a config or wait for the current one to load.", "error");
      return;
    }
    if (parsed && !parsed.ok) {
      toast("Fix the validation errors below before testing.", "error");
      return;
    }
    setTesting(true);
    setVerifyResult(null);
    setVerifyError(null);
    try {
      const { server, client } = await runTests(candidate, candidateLabel);
      if (server?.ok && client?.ok) toast("Connected: Firebase initialization, Auth, and Firestore all passed.");
      else if (server && !server.ok) toast("Connection failed — see the exact reason below.", "error");
      else if (client && !client.ok) toast("This browser cannot reach Firebase — see details below.", "warning");
    } finally {
      setTesting(false);
    }
  };

  const saveAndApply = async () => {
    if (!parsed || !parsed.ok || !parsed.config) {
      toast("Paste a valid Firebase Web App config before saving.", "error");
      return;
    }
    setSaving(true);
    setVerifyResult(null);
    setVerifyError(null);
    try {
      const result = await apiFetch<{ status: FirebaseRuntimeStatus; devEnvSync: { updated: boolean; reason: string } }>(
        "/api/firebase-config",
        { method: "PUT", body: JSON.stringify({ config: parsed.config }) },
      );
      // Apply immediately to the running app: reinitialize the Web SDK with
      // the saved config so Auth/Firestore use it without a reload.
      resetFirebaseRuntimeCache();
      await applyFirebaseWebConfig(parsed.config);
      await fetchFirebaseRuntimeStatus().catch(() => null);
      refresh();
      const label = `saved config (project “${parsed.config.projectId}”)`;
      const { server, client } = await runTests(parsed.config, label);
      if (server?.ok && client?.ok) {
        toast(
          result.status.redeployRequired
            ? "Saved, applied, and connected. Production builds still need the env update + redeploy below."
            : "Saved, applied, and connected. Existing Firebase users can sign in.",
          result.status.redeployRequired ? "warning" : "success",
        );
      } else {
        toast("Saved and applied, but the connection test failed — see the exact reason below.", "error");
      }
    } catch (saveError) {
      const requestId = saveError instanceof ClientApiError ? saveError.requestId ?? undefined : undefined;
      toast(saveError instanceof ClientApiError ? saveError.message : "Save failed.", "error", { requestId });
    } finally {
      setSaving(false);
    }
  };

  const resetToEnv = async () => {
    const confirmed = await confirm({
      title: "Reset Firebase configuration?",
      description:
        "Removes the managed override and returns the app to its build-time NEXT_PUBLIC_FIREBASE_* variables. " +
        "The Firebase SDK reinitializes immediately; your current session stays valid.",
      confirmLabel: "Reset to environment",
      tone: "danger",
    });
    if (!confirmed) return;
    setResetting(true);
    try {
      const result = await apiFetch<{ status: FirebaseRuntimeStatus }>("/api/firebase-config", { method: "DELETE" });
      resetFirebaseRuntimeCache();
      if (result.status.config) await applyFirebaseWebConfig(result.status.config);
      else await clearFirebaseDefaultApp();
      setServerReport(null);
      setClientReport(null);
      setTestedLabel(null);
      refresh();
      toast("Managed override removed. The app now uses its build-time environment config.");
    } catch (resetError) {
      toast(resetError instanceof ClientApiError ? resetError.message : "Reset failed.", "error");
    } finally {
      setResetting(false);
    }
  };

  const verifyLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!candidate) {
      setVerifyError("No configuration available to verify against.");
      return;
    }
    if (parsed && !parsed.ok) {
      setVerifyError("Fix the validation errors above before verifying login.");
      return;
    }
    if (!verifyEmail.trim() || !verifyPassword) {
      setVerifyError("Enter the email and password of an existing Firebase user.");
      return;
    }
    setVerifying(true);
    setVerifyResult(null);
    setVerifyError(null);
    try {
      // Real sign-in on an isolated temporary app (current session untouched),
      // then server-side token verification exactly as the login flow does.
      const { idToken } = await signInToCandidateProject(candidate, verifyEmail, verifyPassword);
      const verified = await apiFetch<{ uid: string; email: string | null; role: string; projectId: string }>(
        "/api/firebase-config/verify-login",
        { method: "POST", body: JSON.stringify({ idToken }) },
      );
      setVerifyResult(verified);
      toast(`Login verified: ${verified.email ?? verified.uid} (${verified.role}).`);
    } catch (verifyFailure) {
      const message = verifyFailure instanceof Error ? verifyFailure.message : "Login verification failed.";
      setVerifyError(message);
    } finally {
      setVerifying(false);
    }
  };

  const copySnippet = async () => {
    if (!status?.envSnippet) return;
    try {
      await navigator.clipboard.writeText(status.envSnippet);
    } catch {
      const area = document.createElement("textarea");
      area.value = status.envSnippet;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      document.body.removeChild(area);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2500);
  };

  return (
    <div className="card-pad space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="section-title">Firebase Configuration</h2>
          <p className="mt-1 text-[13px] text-ink-muted">
            Paste the complete Web App config once. It is validated, saved as the single source of truth,
            applied to the running app immediately, and connection-tested for real.
          </p>
        </div>
        <span className={overall.tone === "ok" ? "badge-success" : overall.tone === "bad" ? "badge-danger" : "badge-neutral"}>
          <span className={`dot ${overall.tone === "ok" ? "bg-emerald-500" : overall.tone === "bad" ? "bg-red-500" : "bg-slate-400"}`} />
          {busy ? "Working…" : overall.label}
        </span>
      </div>

      {loading && (
        <div className="space-y-2" aria-label="Loading Firebase configuration">
          <div className="skeleton h-6 w-48" />
          <div className="skeleton h-24 w-full" />
        </div>
      )}
      {error && !loading && <ErrorState message={error} onRetry={refresh} />}

      {!loading && !error && status && (
        <>
          {/* Current effective configuration */}
          <div className="rounded-lg border border-line p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-ink">Current configuration</p>
              <span className={status.source === "stored" ? "badge-success" : status.source === "env" ? "badge-neutral" : "badge-danger"}>
                {status.source === "stored" ? "Managed override" : status.source === "env" ? "Build environment" : "Missing"}
              </span>
            </div>
            {status.config ? (
              <dl className="mt-3 grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2">
                <div><dt className="text-ink-faint">Project</dt><dd className="mono font-medium text-ink">{status.projectId}</dd></div>
                <div><dt className="text-ink-faint">Auth domain</dt><dd className="mono font-medium text-ink">{status.authDomain}</dd></div>
                <div><dt className="text-ink-faint">API key</dt><dd className="mono font-medium text-ink">{maskFirebaseValue(status.config.apiKey)}</dd></div>
                <div><dt className="text-ink-faint">App ID</dt><dd className="mono font-medium text-ink">{maskFirebaseValue(status.config.appId)}</dd></div>
                {status.updatedAt && (
                  <div><dt className="text-ink-faint">Last saved</dt><dd className="text-ink">{new Date(status.updatedAt).toLocaleString()}</dd></div>
                )}
                <div>
                  <dt className="text-ink-faint">Server session check</dt>
                  <dd className={status.adminProjectMatch ? "font-medium text-emerald-600 dark:text-emerald-400" : "font-medium text-red-600 dark:text-red-400"}>
                    {status.adminProjectMatch
                      ? `Admin project matches (${status.adminProjectId})`
                      : status.adminProjectId
                        ? `Mismatch: server verifies “${status.adminProjectId}”`
                        : "Admin SDK not configured"}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="mt-2 text-[13px] text-ink-muted">
                No Firebase configuration is active. Missing: <span className="mono">{status.missing.join(", ")}</span>
              </p>
            )}
            {status.redeployRequired && (
              <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[13px] text-amber-800 dark:text-amber-200" role="alert">
                <p className="font-semibold">Redeploy required for production builds</p>
                <p className="mt-0.5">
                  The running app uses the managed config above, but fresh builds still boot from the old
                  NEXT_PUBLIC_FIREBASE_* values. Copy the snippet below into Vercel → Project Settings →
                  Environment Variables (all environments), then redeploy.
                </p>
              </div>
            )}
          </div>

          {/* Paste box */}
          <div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="field-label" htmlFor="firebase-config-json">Paste Firebase Web App config (JSON)</label>
              <div className="flex gap-2">
                {status.config && (
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    onClick={() => setRaw(JSON.stringify(status.config, null, 2))}
                  >
                    Load current
                  </button>
                )}
                {raw && (
                  <button type="button" className="btn-secondary btn-sm" onClick={() => setRaw("")}>Clear</button>
                )}
              </div>
            </div>
            <textarea
              id="firebase-config-json"
              className="field-input mono min-h-44"
              rows={9}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              placeholder={FIREBASE_CONFIG_EXAMPLE}
              value={raw}
              onChange={(event) => setRaw(event.target.value)}
              aria-describedby="firebase-config-help"
            />
            <p id="firebase-config-help" className="field-hint">
              Firebase Console → Project settings → General → Your apps → Web app → SDK setup and configuration.
              Service-account private keys are rejected here — Admin credentials stay server-side in Vercel.
            </p>

            {parsed && (
              <div className="mt-3 space-y-3">
                <ul className="grid gap-1.5 sm:grid-cols-2" aria-label="Detected fields">
                  {KNOWN_FIREBASE_FIELDS.map((field) => {
                    const present = parsed.detected[field];
                    const required = (REQUIRED_FIREBASE_FIELDS as readonly string[]).includes(field);
                    const optionalMissing = (OPTIONAL_FIREBASE_FIELDS as readonly string[]).includes(field) && !present;
                    return (
                      <li key={field} className="flex items-center gap-2 text-[13px]">
                        {present ? (
                          <Check className="h-4 w-4 text-emerald-500" />
                        ) : optionalMissing ? (
                          <span className="grid h-4 w-4 place-items-center text-[11px] text-ink-faint">–</span>
                        ) : (
                          <XCircle className="h-4 w-4 text-red-500" />
                        )}
                        <span className="mono text-ink">{field}</span>
                        <span className="text-xs text-ink-faint">{required ? "required" : "optional"}</span>
                      </li>
                    );
                  })}
                </ul>
                {parsed.errors.length > 0 && (
                  <div className="rounded-lg bg-red-500/10 px-3 py-2.5 text-[13px] text-red-600 dark:text-red-400" role="alert">
                    <p className="font-semibold">Fix these before saving:</p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-5">
                      {parsed.errors.map((issue) => (
                        <li key={`${issue.field}-${issue.message}`}>{issue.message}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {parsed.warnings.length > 0 && (
                  <div className="rounded-lg bg-amber-500/10 px-3 py-2.5 text-[13px] text-amber-800 dark:text-amber-200">
                    <p className="font-semibold">Warnings (saving is still allowed):</p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-5">
                      {parsed.warnings.map((issue) => (
                        <li key={`${issue.field}-${issue.message}`}>{issue.message}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {parsed.ok && parsed.errors.length === 0 && parsed.warnings.length === 0 && (
                  <p className="flex items-center gap-1.5 text-[13px] text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="h-4 w-4" /> Valid config for project “{parsed.config?.projectId}”. Ready to test and save.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex flex-wrap gap-2.5">
            <button
              type="button"
              className="btn-secondary"
              onClick={testConnection}
              disabled={busy || !candidate || Boolean(parsed && !parsed.ok)}
            >
              {testing ? <Spinner /> : <FlaskConical className="h-4 w-4" />} Test connection
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={saveAndApply}
              disabled={busy || !parsed?.ok}
            >
              {saving ? <Spinner /> : <Save className="h-4 w-4" />} Save &amp; apply
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={resetToEnv}
              disabled={busy || !status.hasStoredOverride}
              title={status.hasStoredOverride ? "Remove the managed override" : "No managed override to remove"}
            >
              {resetting ? <Spinner /> : <RotateCcw className="h-4 w-4" />} Reset
            </button>
          </div>

          {/* Reports */}
          {(serverReport || clientReport) && (
            <div className="space-y-3">
              {testedLabel && <p className="text-xs text-ink-faint">Last tested: {testedLabel}</p>}
              <ReportBlock
                title="Server connection test"
                hint="Authoritative: Identity Toolkit, Email/Password provider, Firestore, and Admin project match."
                report={serverReport}
              />
              <ReportBlock
                title="Browser connection test"
                hint="This browser: real Web SDK initialization plus direct Auth/Firestore reachability."
                report={clientReport}
              />
            </div>
          )}

          {/* Login verification */}
          <div className="rounded-lg border border-line p-3.5">
            <p className="flex items-center gap-2 text-sm font-semibold text-ink">
              <KeyRound className="h-4 w-4" /> Verify login with an existing Firebase user
            </p>
            <p className="mt-1 text-[13px] text-ink-muted">
              Signs in on an isolated test app and verifies the token server-side exactly as the login page does.
              Your current dashboard session is never touched.
            </p>
            <form onSubmit={verifyLogin} className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
              <div>
                <label className="field-label" htmlFor="fb-verify-email">Firebase email</label>
                <input
                  id="fb-verify-email"
                  type="email"
                  autoComplete="off"
                  className="field-input"
                  value={verifyEmail}
                  onChange={(event) => setVerifyEmail(event.target.value)}
                  placeholder="you@organization.org"
                  disabled={verifying}
                />
              </div>
              <div>
                <label className="field-label" htmlFor="fb-verify-password">Password</label>
                <input
                  id="fb-verify-password"
                  type="password"
                  autoComplete="new-password"
                  className="field-input"
                  value={verifyPassword}
                  onChange={(event) => setVerifyPassword(event.target.value)}
                  placeholder="••••••••"
                  disabled={verifying}
                />
              </div>
              <div className="flex items-end">
                <button type="submit" className="btn-secondary" disabled={verifying || !candidate}>
                  {verifying && <Spinner />} Verify login
                </button>
              </div>
            </form>
            {verifyResult && (
              <p className="mt-3 flex items-start gap-2 rounded-lg bg-emerald-500/10 px-3 py-2.5 text-[13px] text-emerald-700 dark:text-emerald-300" role="status">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Login works end-to-end: <span className="font-semibold">{verifyResult.email ?? verifyResult.uid}</span>
                  {" "}· role <span className="font-semibold">{verifyResult.role}</span> · project “{verifyResult.projectId}”.
                </span>
              </p>
            )}
            {verifyError && (
              <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2.5 text-[13px] text-red-600 dark:text-red-400" role="alert">
                {verifyError}
              </p>
            )}
          </div>

          {/* Production env sync */}
          {status.envSnippet && (
            <div className="rounded-lg border border-line p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold text-ink">Production environment sync</p>
                <button type="button" className="btn-secondary btn-sm" onClick={copySnippet}>
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? "Copied" : "Copy variables"}
                </button>
              </div>
              <p className="mt-1 text-[13px] text-ink-muted">
                Vercel → Project Settings → Environment Variables → paste for Production (and Preview) → Redeploy.
                In local development the file below is updated automatically on save.
              </p>
              <pre className="mono mt-2 overflow-x-auto rounded-md bg-surface-sunken p-3 text-[12px] leading-5 text-ink">
                {status.envSnippet}
              </pre>
            </div>
          )}
        </>
      )}
    </div>
  );
}
