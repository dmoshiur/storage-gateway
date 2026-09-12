"use client";

import { useMemo, useRef, useState } from "react";
import { Play, ShieldCheck, Upload } from "lucide-react";
import { V1_ENDPOINTS, type EndpointDef } from "@/lib/api/endpoints";
import { AsyncButton } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/data";

interface PlaygroundResult {
  ok: boolean;
  status: number;
  ms: number;
  body: string;
  requestId: string | null;
}

interface SelfTestCheck {
  step: string;
  ok: boolean;
  detail: string;
}

type AuthMode = "keypair" | "bearer";

const PLAYGROUND_METHODS: EndpointDef["method"][] = ["GET", "POST", "PATCH", "DELETE"];

/**
 * The playground is a plain cross-origin HTTP client. It deliberately sends the
 * SAME credential headers an external website sends — `X-AM-Storage-Key-Id` +
 * `X-AM-Storage-Key-Secret` (or `Authorization: Bearer`) — and never relies on
 * the admin session cookie, so a request that succeeds here is a request that
 * succeeds from cURL.
 */
export function ApiPlaygroundTab({ baseUrl }: { baseUrl: string }) {
  const playable = useMemo(
    () => V1_ENDPOINTS.filter((def) => PLAYGROUND_METHODS.includes(def.method) && !def.requestBody?.includes("multipart/form-data")),
    [],
  );
  const [preset, setPreset] = useState(0);
  const [authMode, setAuthMode] = useState<AuthMode>("keypair");
  const [keyId, setKeyId] = useState("");
  const [secret, setSecret] = useState("");
  const [fileId, setFileId] = useState("");
  const [path, setPath] = useState(playable[0]!.path);
  const [body, setBody] = useState(playable[0]!.requestBody ?? "");
  const [result, setResult] = useState<PlaygroundResult | null>(null);
  const [selfTest, setSelfTest] = useState<{ ok: boolean; checks: SelfTestCheck[]; message?: string } | null>(null);
  const [pdf, setPdf] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const def = playable[preset]!;

  const origin = () => baseUrl || window.location.origin;

  /** Exactly the headers an external integration sends. No cookies, ever. */
  const authHeaders = (): Record<string, string> =>
    authMode === "keypair"
      ? { "X-AM-Storage-Key-Id": keyId.trim(), "X-AM-Storage-Key-Secret": secret.trim() }
      : { Authorization: `Bearer ${secret.trim()}` };

  const record = async (response: Response, started: number) => {
    const text = await response.text();
    let pretty = text;
    try {
      pretty = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      /* leave raw text */
    }
    setResult({
      ok: response.ok,
      status: response.status,
      ms: Math.round(performance.now() - started),
      body: pretty,
      requestId: response.headers.get("X-Request-Id"),
    });
    return text;
  };

  const applyPreset = (index: number) => {
    setPreset(index);
    const next = playable[index]!;
    setPath(next.path);
    setBody(next.requestBody ?? "");
    setResult(null);
  };

  const send = async () => {
    let url = path.trim();
    if (!url.startsWith("http")) url = `${origin()}${url.startsWith("/") ? "" : "/"}${url}`;
    url = url.replace(":id", fileId.trim() || "FILE_ID");
    const started = performance.now();
    const hasBody = def.method !== "GET" && def.method !== "DELETE";
    try {
      const response = await fetch(url, {
        method: def.method,
        // `omit` guarantees the admin session cookie is never sent, so this
        // request proves API-key authentication on its own.
        credentials: "omit",
        headers: { ...authHeaders(), ...(hasBody ? { "Content-Type": "application/json" } : {}) },
        body: hasBody ? body || undefined : undefined,
      });
      await record(response, started);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setResult({ ok: false, status: 0, ms: Math.round(performance.now() - started), body: `Network error: ${message}`, requestId: null });
      throw error;
    }
  };

  const uploadPdf = async () => {
    if (!pdf) return;
    const started = performance.now();
    const form = new FormData();
    form.append("file", pdf);
    form.append("title", pdf.name.replace(/\.pdf$/i, ""));
    try {
      const response = await fetch(`${origin()}/api/v1/files`, {
        method: "POST",
        credentials: "omit",
        // Content-Type is intentionally omitted so the browser sets the
        // multipart boundary, exactly as an external client would.
        headers: authHeaders(),
        body: form,
      });
      await record(response, started);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setResult({ ok: false, status: 0, ms: Math.round(performance.now() - started), body: `Network error: ${message}`, requestId: null });
      throw error;
    }
  };

  const runSelfTest = async () => {
    setSelfTest(null);
    const started = performance.now();
    try {
      const response = await fetch(`${origin()}/api/v1/auth/test`, {
        method: "POST",
        credentials: "omit",
        headers: authHeaders(),
      });
      const text = await record(response, started);
      const parsed = JSON.parse(text) as { success: boolean; data?: { ok: boolean; checks: SelfTestCheck[] }; error?: { message: string } };
      if (parsed.success && parsed.data) setSelfTest({ ok: parsed.data.ok, checks: parsed.data.checks });
      else setSelfTest({ ok: false, checks: [], message: parsed.error?.message ?? "The key could not be verified." });
    } catch (error) {
      setSelfTest({ ok: false, checks: [], message: error instanceof Error ? error.message : String(error) });
    }
  };

  const credentialsReady = authMode === "keypair" ? Boolean(keyId.trim() && secret.trim()) : Boolean(secret.trim());
  const needsId = def.path.includes(":id");
  const canSend = credentialsReady && Boolean(path.trim()) && (!needsId || Boolean(fileId.trim()));

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <div className="card-pad space-y-4">
        <div>
          <h2 className="section-title">Request</h2>
          <p className="mt-1 text-[13px] text-ink-muted">
            Sends the exact headers an external website sends. Cookies are never attached, so anything that works here works from cURL.
            Credentials live in memory only.
          </p>
        </div>

        <div>
          <span className="field-label">Authentication</span>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {([
              ["keypair", "Key ID + Secret"],
              ["bearer", "Authorization: Bearer"],
            ] as const).map(([mode, label]) => (
              <label key={mode} className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-line px-3 py-2 text-[13px] hover:bg-surface-sunken">
                <input type="radio" name="pg-auth" className="field-check" checked={authMode === mode} onChange={() => setAuthMode(mode)} />
                <span className="font-mono text-xs">{label}</span>
              </label>
            ))}
          </div>
        </div>

        {authMode === "keypair" && (
          <div>
            <label className="field-label" htmlFor="pg-key-id">Key ID</label>
            <input
              id="pg-key-id"
              className="field-input font-mono"
              value={keyId}
              autoComplete="off"
              onChange={(event) => setKeyId(event.target.value)}
              placeholder="ng_key_…"
            />
            <p className="field-hint">Sent as <span className="font-mono">X-AM-Storage-Key-Id</span>.</p>
          </div>
        )}

        <div>
          <label className="field-label" htmlFor="pg-secret">Key secret</label>
          <input
            id="pg-secret"
            type="password"
            className="field-input font-mono"
            value={secret}
            autoComplete="off"
            onChange={(event) => setSecret(event.target.value)}
            placeholder="ng_live_…"
          />
          <p className="field-hint">
            Sent as <span className="font-mono">{authMode === "keypair" ? "X-AM-Storage-Key-Secret" : "Authorization: Bearer …"}</span>.
          </p>
        </div>

        <div className="rounded-lg border border-line bg-surface-sunken px-3 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-ink">Test API key</p>
              <p className="text-xs text-ink-muted">Verifies key → scope → upload permission → Vercel Blob → database.</p>
            </div>
            <AsyncButton className="btn-secondary btn-sm" onClick={runSelfTest} disabled={!credentialsReady} loadingLabel="Testing…">
              <ShieldCheck className="h-3.5 w-3.5" /> Run test
            </AsyncButton>
          </div>
          {selfTest && (
            <div className="mt-2.5 space-y-1.5">
              {selfTest.message && <p className="text-[13px] text-red-600 dark:text-red-400">{selfTest.message}</p>}
              {selfTest.checks.map((check) => (
                <p key={check.step} className="flex items-start gap-2 text-xs">
                  <span className={check.ok ? "badge-success" : "badge-danger"}>{check.ok ? "pass" : "fail"}</span>
                  <span className="min-w-0 text-ink-muted"><span className="font-mono text-ink">{check.step}</span> — {check.detail}</span>
                </p>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-lg border border-line bg-surface-sunken px-3 py-2.5">
          <p className="text-[13px] font-semibold text-ink">Upload a PDF</p>
          <p className="text-xs text-ink-muted">
            <span className="font-mono">POST /api/v1/files</span> as multipart/form-data — scope <span className="font-mono">files:upload</span>.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              accept="application/pdf,.pdf"
              className="field-input text-xs"
              onChange={(event) => setPdf(event.target.files?.[0] ?? null)}
            />
            <AsyncButton className="btn-secondary btn-sm" onClick={uploadPdf} disabled={!credentialsReady || !pdf} loadingLabel="Uploading…">
              <Upload className="h-3.5 w-3.5" /> Upload
            </AsyncButton>
          </div>
        </div>

        <div>
          <label className="field-label" htmlFor="pg-preset">Endpoint</label>
          <select id="pg-preset" className="field-input font-mono" value={preset} onChange={(event) => applyPreset(Number(event.target.value))}>
            {playable.map((option, index) => (
              <option key={`${option.method} ${option.path}`} value={index}>
                [{option.method}] {option.path}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-3 sm:grid-cols-[90px_1fr]">
          <div>
            <label className="field-label" htmlFor="pg-method">Method</label>
            <select id="pg-method" className="field-input font-mono" value={def.method} disabled>
              {PLAYGROUND_METHODS.map((candidate) => <option key={candidate}>{candidate}</option>)}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="pg-path">Path</label>
            <input id="pg-path" className="field-input font-mono text-[13px]" value={path} onChange={(event) => setPath(event.target.value)} spellCheck={false} />
          </div>
        </div>
        {needsId && (
          <div>
            <label className="field-label" htmlFor="pg-id">File ID (replaces :id)</label>
            <input id="pg-id" className="field-input font-mono" value={fileId} onChange={(event) => setFileId(event.target.value)} placeholder="Paste a file id" />
          </div>
        )}
        {def.method !== "GET" && def.method !== "DELETE" && (
          <div>
            <label className="field-label" htmlFor="pg-body">JSON body</label>
            <textarea id="pg-body" className="field-input min-h-28 font-mono text-xs" value={body} onChange={(event) => setBody(event.target.value)} spellCheck={false} />
          </div>
        )}
        <div className="flex items-center gap-2">
          <AsyncButton className="btn-primary" onClick={send} disabled={!canSend} loadingLabel="Sending…">
            <Play className="h-4 w-4" /> Send request
          </AsyncButton>
          {def.scope && <span className="font-mono text-[11px] text-ink-faint">scope: {def.scope}</span>}
        </div>
      </div>
      <div className="card-pad space-y-3">
        <h2 className="section-title">Response</h2>
        {!result && <p className="py-10 text-center text-[13px] text-ink-faint">Send a request to see the status and body.</p>}
        {result && (
          <>
            <p className="flex flex-wrap items-center gap-2 text-[13px]">
              <span className={result.ok ? "badge-success" : "badge-danger"}>{result.status || "failed"}</span>
              <span className="tnum text-ink-muted">{result.ms} ms</span>
              {result.requestId && <span className="font-mono text-[11px] text-ink-faint">requestId: {result.requestId}</span>}
            </p>
            <div className="max-h-[26rem] overflow-auto rounded-lg">
              <CodeBlock code={result.body} language="json" />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
