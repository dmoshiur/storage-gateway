"use client";

import { useEffect, useState } from "react";
import { Ban, Check, Clipboard, KeyRound, Plus, ShieldCheck, Sparkles } from "lucide-react";
import { apiFetch, ClientApiError } from "@/lib/client/api";
import { Notice } from "@/components/ui/notice";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/utils/format";

interface ApiKey {
  id: string;
  prefix: string;
  createdAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** Public bridge origin shown in the copyable snippets. Set NEXT_PUBLIC_BRIDGE_URL to the deployed bridge origin. */
const bridgeUrl = (process.env.NEXT_PUBLIC_BRIDGE_URL ?? "https://bridge.your-domain.example").replace(/\/+$/, "");

function apiError(caught: unknown, fallback: string): string {
  return caught instanceof ClientApiError ? caught.message : fallback;
}

export function ApiManagement() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function load() {
    try {
      const result = await apiFetch<{ keys: ApiKey[] }>("/api/api-keys");
      setKeys(result.keys);
    } catch (caught) {
      setError(apiError(caught, "Unable to load API keys."));
    }
  }

  useEffect(() => {
    let alive = true;
    void apiFetch<{ keys: ApiKey[] }>("/api/api-keys")
      .then((result) => { if (alive) setKeys(result.keys); })
      .catch((caught) => { if (alive) setError(apiError(caught, "Unable to load API keys.")); });
    return () => { alive = false; };
  }, []);

  async function generate() {
    setGenerating(true);
    setError(null);
    setNewKey(null);
    try {
      const result = await apiFetch<{ id: string; key: string }>("/api/api-keys", { method: "POST", body: "{}" });
      setNewKey(result.key);
      await load();
    } catch (caught) {
      setError(apiError(caught, "Unable to generate key."));
    } finally {
      setGenerating(false);
    }
  }

  async function revoke(id: string) {
    setRevokingId(id);
    setError(null);
    try {
      await apiFetch(`/api/api-keys?id=${encodeURIComponent(id)}`, { method: "DELETE", body: "{}" });
      await load();
    } catch (caught) {
      setError(apiError(caught, "Unable to revoke key."));
    } finally {
      setRevokingId(null);
    }
  }

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      window.setTimeout(() => setCopied((current) => (current === label ? null : current)), 2000);
    } catch {
      setError("Clipboard access is unavailable in this browser. Select and copy the text manually.");
    }
  }

  const snippetKey = newKey ?? "am_store_live_REPLACE_WITH_GENERATED_KEY";
  const curlSnippet = [
    `curl -X POST ${bridgeUrl}/api/v1/storage/upload \\`,
    `  -H 'X-AM-Storage-Key: ${snippetKey}' \\`,
    "  -F 'file=@annual-report.pdf' \\",
    "  -F 'title=Annual Report 2026'",
  ].join("\n");
  const nodeSnippet = [
    "// gramunnayan.com → AM Storage Company bridge (server-side only)",
    "const form = new FormData();",
    'form.append("file", fs.createReadStream("annual-report.pdf"), "annual-report.pdf");',
    'form.append("title", "Annual Report 2026");',
    "",
    "const response = await fetch(`${process.env.AM_STORAGE_BRIDGE_URL}/api/v1/storage/upload`, {",
    "  method: \"POST\",",
    "  headers: { \"X-AM-Storage-Key\": process.env.AM_STORAGE_API_KEY }, // never expose in the browser",
    "  body: form,",
    "});",
    'const result = await response.json();',
    '// result.data.file  → permanent metadata record (id, title, size, retention, status)',
    "// result.data.url   → temporary signed PDF URL returned to your visitors",
  ].join("\n");

  return (
    <div className="space-y-6">
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wider text-ngo-600">AM Storage Company · Storage Bridge</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-ink-900 sm:text-3xl">API Management</h1>
          <p className="mt-2 max-w-2xl text-sm text-slate-600">
            Generate and revoke Custom API Keys for gramunnayan.com. Keys authorize the public gateway endpoint below and are
            verified server-to-server by the bridge. R2 credentials are never exposed to the client site.
          </p>
        </div>
      </header>

      {error && <Notice type="error">{error}</Notice>}

      {newKey && (
        <Notice type="warning">
          <strong>Copy this key now — it cannot be displayed again.</strong> Send it to the gramunnayan.com server over a private
          channel and store it in its environment (never in browser code or client bundles).
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <code className="break-all rounded bg-amber-100 px-2 py-1 text-sm font-bold">{newKey}</code>
            <Button variant="secondary" onClick={() => void copy(newKey, "key")}>
              {copied === "key" ? <Check className="h-4 w-4" /> : <Clipboard className="h-4 w-4" />}
              {copied === "key" ? "Copied" : "Copy key"}
            </Button>
          </div>
        </Notice>
      )}

      <section className="panel p-5 sm:p-6">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <h2 className="flex items-center gap-2 font-bold text-ink-900"><ShieldCheck className="h-5 w-5 text-ngo-600" />Custom API keys</h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
              Keys are prefixed <code className="font-mono text-xs">am_store_live_</code>, high-entropy, and stored only as SHA-256
              digests. Revoking a key takes effect immediately on the next bridge request.
            </p>
          </div>
          <Button onClick={() => void generate()} disabled={generating} className="shrink-0">
            <Plus className="h-4 w-4" />{generating ? "Generating…" : "Generate key"}
          </Button>
        </div>

        {keys.length === 0 ? (
          <p className="mt-5 rounded-lg border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500">
            No Custom API keys yet. Generate the first key for gramunnayan.com above.
          </p>
        ) : (
          <ul className="mt-5 divide-y divide-slate-100">
            {keys.map((key) => (
              <li className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between" key={key.id}>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <KeyRound className="h-4 w-4 shrink-0 text-ngo-600" />
                    <code className="font-mono text-sm font-semibold text-ink-900">{key.prefix}••••••</code>
                    {key.revokedAt
                      ? <span className="rounded bg-red-50 px-2 py-0.5 text-xs font-bold text-red-700">Revoked</span>
                      : <span className="rounded bg-ngo-50 px-2 py-0.5 text-xs font-bold text-ngo-700">Active</span>}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    Created {formatDate(key.createdAt)} · {key.lastUsedAt ? `Last used ${formatDate(key.lastUsedAt)}` : "Never used"}
                  </p>
                </div>
                {!key.revokedAt && (
                  <Button variant="ghost" onClick={() => void revoke(key.id)} disabled={revokingId === key.id} className="shrink-0 self-start sm:self-auto">
                    <Ban className="h-4 w-4" />{revokingId === key.id ? "Revoking…" : "Revoke"}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel p-5 sm:p-6">
        <h2 className="flex items-center gap-2 font-bold text-ink-900"><Sparkles className="h-5 w-5 text-ngo-600" />gramunnayan.com integration guide</h2>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">
          The NGO website sends multipart form data with one PDF per request to the unified public gateway endpoint using the
          generated key in the <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs">X-AM-Storage-Key</code> header.
          The bridge validates the key, streams the PDF to private Cloudflare R2, registers the document, and returns a signed URL.
        </p>

        <div className="mt-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-bold text-ink-900">1 · cURL (quick test)</p>
            <Button variant="secondary" onClick={() => void copy(curlSnippet, "curl")}>
              {copied === "curl" ? <Check className="h-4 w-4" /> : <Clipboard className="h-4 w-4" />}
              {copied === "curl" ? "Copied" : "Copy"}
            </Button>
          </div>
          <pre className="mt-2 overflow-auto rounded-lg bg-slate-950 p-4 text-xs leading-5 text-slate-100">{curlSnippet}</pre>
        </div>

        <div className="mt-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-bold text-ink-900">2 · Node.js (production, gramunnayan.com server)</p>
            <Button variant="secondary" onClick={() => void copy(nodeSnippet, "node")}>
              {copied === "node" ? <Check className="h-4 w-4" /> : <Clipboard className="h-4 w-4" />}
              {copied === "node" ? "Copied" : "Copy"}
            </Button>
          </div>
          <pre className="mt-2 overflow-auto rounded-lg bg-slate-950 p-4 text-xs leading-5 text-slate-100">{nodeSnippet}</pre>
        </div>

        <Notice type="info">
          <strong>Security boundary.</strong> The request above must be issued by the gramunnayan.com <em>server</em>. Keep{" "}
          <code className="rounded bg-blue-100 px-1.5 py-0.5 font-mono text-xs">AM_STORAGE_API_KEY</code> and the Cloudflare R2
          credentials out of browser JavaScript. Visitors should only ever receive the signed PDF URL the bridge returns.
        </Notice>
      </section>
    </div>
  );
}
