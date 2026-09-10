"use client";

import { useMemo, useState } from "react";
import { Play } from "lucide-react";
import { V1_ENDPOINTS, type EndpointDef } from "@/lib/api/endpoints";
import { AsyncButton } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/data";

interface PlaygroundResult {
  ok: boolean;
  status: number;
  ms: number;
  body: string;
}

const PLAYGROUND_METHODS: EndpointDef["method"][] = ["GET", "POST", "PATCH", "DELETE"];

export function ApiPlaygroundTab({ baseUrl }: { baseUrl: string }) {
  const playable = useMemo(
    () => V1_ENDPOINTS.filter((def) => PLAYGROUND_METHODS.includes(def.method) && !def.requestBody?.includes("multipart/form-data")),
    [],
  );
  const [preset, setPreset] = useState(0);
  const [secret, setSecret] = useState("");
  const [fileId, setFileId] = useState("");
  const [path, setPath] = useState(playable[0]!.path);
  const [body, setBody] = useState(playable[0]!.requestBody ?? "");
  const [result, setResult] = useState<PlaygroundResult | null>(null);

  const def = playable[preset]!;

  const applyPreset = (index: number) => {
    setPreset(index);
    const next = playable[index]!;
    setPath(next.path);
    setBody(next.requestBody ?? "");
    setResult(null);
  };

  const send = async () => {
    const origin = baseUrl || window.location.origin;
    let url = path.trim();
    if (!url.startsWith("http")) url = `${origin}${url.startsWith("/") ? "" : "/"}${url}`;
    url = url.replace(":id", fileId.trim() || "FILE_ID");
    const started = performance.now();
    try {
      const response = await fetch(url, {
        method: def.method,
        headers: {
          Authorization: `Bearer ${secret.trim()}`,
          ...(def.method === "GET" || def.method === "DELETE" ? {} : { "Content-Type": "application/json" }),
        },
        body: def.method === "GET" || def.method === "DELETE" ? undefined : body || undefined,
      });
      const text = await response.text();
      let pretty = text;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* leave raw text */
      }
      setResult({ ok: response.ok, status: response.status, ms: Math.round(performance.now() - started), body: pretty });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setResult({ ok: false, status: 0, ms: Math.round(performance.now() - started), body: `Network error: ${message}` });
      throw error;
    }
  };

  const needsId = def.path.includes(":id");
  const canSend = Boolean(secret.trim()) && Boolean(path.trim()) && (!needsId || Boolean(fileId.trim()));

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <div className="card-pad space-y-4">
        <div>
          <h2 className="section-title">Request</h2>
          <p className="mt-1 text-[13px] text-ink-muted">Paste a key secret — it lives in memory only and is never stored.</p>
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
        <div>
          <label className="field-label" htmlFor="pg-secret">API key</label>
          <input
            id="pg-secret"
            type="password"
            className="field-input font-mono"
            value={secret}
            autoComplete="off"
            onChange={(event) => setSecret(event.target.value)}
            placeholder="ng_live_…"
          />
          <p className="field-hint">Sent as <span className="font-mono">Authorization: Bearer …</span>.</p>
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
            <p className="flex items-center gap-2 text-[13px]">
              <span className={result.ok ? "badge-success" : "badge-danger"}>{result.status || "failed"}</span>
              <span className="tnum text-ink-muted">{result.ms} ms</span>
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
