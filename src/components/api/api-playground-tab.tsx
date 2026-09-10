"use client";

import { useState } from "react";
import { Play } from "lucide-react";
import { useQuery } from "@/hooks/use-query";
import { CodeBlock } from "@/components/ui/data";
import { Spinner } from "@/components/ui/feedback";

const PATHS = [
  { label: "List files — GET /api/bridge/files", method: "GET", path: "/api/bridge/files?pageSize=5" },
  { label: "Get file — GET /api/bridge/files?id=…", method: "GET", path: "/api/bridge/files?id=" },
  { label: "Add by URL — POST /api/bridge/files", method: "POST", path: "/api/bridge/files", body: '{\n  "url": "https://example.org/report.pdf",\n  "title": "Example report"\n}' },
  { label: "Update — PATCH /api/bridge/files?id=…", method: "PATCH", path: "/api/bridge/files?id=", body: '{\n  "title": "New title"\n}' },
  { label: "Preview URL — GET /api/bridge/files/preview?id=…", method: "GET", path: "/api/bridge/files/preview?id=" },
  { label: "Categories — GET /api/bridge/categories", method: "GET", path: "/api/bridge/categories" },
];

interface PlaygroundResult {
  ok: boolean;
  status: number;
  ms: number;
  body: string;
}

export function ApiPlaygroundTab() {
  const keys = useQuery<{ keys: { id: string; keyId: string | null; name: string; revokedAt: string | null }[] }>("/api/api-keys");
  const [keyId, setKeyId] = useState("");
  const [secret, setSecret] = useState("");
  const [preset, setPreset] = useState(0);
  const [method, setMethod] = useState("GET");
  const [path, setPath] = useState(PATHS[0].path);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<PlaygroundResult | null>(null);

  const applyPreset = (index: number) => {
    setPreset(index);
    setMethod(PATHS[index].method);
    setPath(PATHS[index].path);
    setBody(PATHS[index].body ?? "");
    setResult(null);
  };

  const send = async () => {
    setSending(true);
    setResult(null);
    const started = performance.now();
    try {
      const response = await fetch(path, {
        method,
        headers: {
          "X-AM-Storage-Key-Id": keyId.trim(),
          "X-AM-Storage-Key-Secret": secret.trim(),
          ...(method === "GET" || method === "DELETE" ? {} : { "Content-Type": "application/json" }),
        },
        body: method === "GET" || method === "DELETE" ? undefined : body || undefined,
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
      setResult({ ok: false, status: 0, ms: Math.round(performance.now() - started), body: String(error) });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <div className="card-pad space-y-4">
        <div>
          <h2 className="section-title">Request</h2>
          <p className="mt-1 text-[13px] text-ink-muted">Paste a key secret — it only lives in memory and is never stored.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="field-label" htmlFor="pg-key">Key ID</label>
            <input
              id="pg-key"
              className="field-input font-mono"
              list="pg-keys"
              value={keyId}
              onChange={(event) => setKeyId(event.target.value)}
              placeholder="Paste a key ID"
            />
            <datalist id="pg-keys">
              {(keys.data?.keys ?? []).filter((key) => key.keyId && !key.revokedAt).map((key) => (
                <option key={key.id} value={key.keyId!}>{key.name}</option>
              ))}
            </datalist>
          </div>
          <div>
            <label className="field-label" htmlFor="pg-secret">Key secret</label>
            <input
              id="pg-secret"
              type="password"
              className="field-input font-mono"
              value={secret}
              autoComplete="off"
              onChange={(event) => setSecret(event.target.value)}
              placeholder="Saved at creation"
            />
          </div>
        </div>
        <div>
          <label className="field-label" htmlFor="pg-preset">Endpoint template</label>
          <select id="pg-preset" className="field-input" value={preset} onChange={(event) => applyPreset(Number(event.target.value))}>
            {PATHS.map((option, index) => (
              <option key={option.label} value={index}>{option.label}</option>
            ))}
          </select>
        </div>
        <div className="grid gap-3 sm:grid-cols-[110px_1fr]">
          <div>
            <label className="field-label" htmlFor="pg-method">Method</label>
            <select id="pg-method" className="field-input font-mono" value={method} onChange={(event) => setMethod(event.target.value)}>
              {["GET", "POST", "PATCH", "PUT", "DELETE"].map((candidate) => (
                <option key={candidate}>{candidate}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="pg-path">Path</label>
            <input id="pg-path" className="field-input font-mono text-[13px]" value={path} onChange={(event) => setPath(event.target.value)} placeholder="/api/bridge/files…" spellCheck={false} />
          </div>
        </div>
        {method !== "GET" && method !== "DELETE" && (
          <div>
            <label className="field-label" htmlFor="pg-body">JSON body</label>
            <textarea id="pg-body" className="field-input min-h-28 font-mono text-xs" value={body} onChange={(event) => setBody(event.target.value)} spellCheck={false} />
          </div>
        )}
        <div>
          <button type="button" className="btn-primary" onClick={send} disabled={sending || !keyId.trim() || !secret.trim() || !path.trim()}>
            {sending ? <Spinner /> : <Play className="h-4 w-4" />} Send request
          </button>
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
              <CodeBlock code={result.body} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
