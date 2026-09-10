"use client";

import { useEffect, useState } from "react";
import { Ban, Check, Clipboard, KeyRound, Plus, ShieldCheck, Sparkles } from "lucide-react";
import { apiFetch, ClientApiError } from "@/lib/client/api";
import { Notice } from "@/components/ui/notice";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/utils/format";

interface ApiKey {
  id: string;
  /** Visible identifier (dual-token era). Null for pre-upgrade legacy keys. */
  keyId: string | null;
  prefix: string;
  createdAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface NewCredential {
  keyId: string;
  keySecret: string;
}

/** Public bridge origin shown in the copyable snippets. Set NEXT_PUBLIC_BRIDGE_URL to the deployed FastAPI bridge origin. */
const DEFAULT_BRIDGE_URL = "https://bridge.your-domain.example";
const bridgeUrl = (process.env.NEXT_PUBLIC_BRIDGE_URL ?? DEFAULT_BRIDGE_URL).replace(/\/+$/, "");

function apiError(caught: unknown, fallback: string): string {
  return caught instanceof ClientApiError ? caught.message : fallback;
}

export function ApiManagement() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [newCredential, setNewCredential] = useState<NewCredential | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void apiFetch<{ keys: ApiKey[] }>("/api/api-keys")
      .then((result) => { if (alive) setKeys(result.keys); })
      .catch((caught) => { if (alive) setError(apiError(caught, "Unable to load API keys.")); });
    return () => { alive = false; };
  }, []);

  async function load() {
    try {
      const result = await apiFetch<{ keys: ApiKey[] }>("/api/api-keys");
      setKeys(result.keys);
    } catch (caught) {
      setError(apiError(caught, "Unable to load API keys."));
    }
  }

  async function generate() {
    setGenerating(true);
    setError(null);
    setNewCredential(null);
    try {
      const result = await apiFetch<NewCredential & { id: string }>("/api/api-keys", { method: "POST", body: "{}" });
      setNewCredential({ keyId: result.keyId, keySecret: result.keySecret });
      await load();
    } catch (caught) {
      setError(apiError(caught, "Unable to generate API credential."));
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

  const snippetKeyId = newCredential?.keyId ?? "am_store_live_REPLACE_WITH_KEY_ID";
  const snippetSecret = newCredential?.keySecret ?? "am_sec_live_REPLACE_WITH_SECRET";
  const curlSnippet = [
    `curl -X POST ${bridgeUrl}/api/v1/storage/upload \\`,
    `  -H 'X-AM-Storage-Key-Id: ${snippetKeyId}' \\`,
    `  -H 'X-AM-Storage-Key-Secret: ${snippetSecret}' \\`,
    "  -F 'file=@annual-report.pdf' \\",
    "  -F 'title=Annual Report 2026'",
  ].join("\n");
  const nodeSnippet = [
    "// gramunnayan.com → AM Storage Company bridge (server-side only)",
    "import { createHmac, createHash } from \"node:crypto\";",
    "",
    "const base = process.env.AM_STORAGE_BRIDGE_URL;",
    "const keyId = process.env.AM_STORAGE_KEY_ID;          // am_store_live_… (visible)",
    "const keySecret = process.env.AM_STORAGE_KEY_SECRET;  // am_sec_live_… (env only)",
    "",
    "// ── 1) Dual-token mode (recommended) ─────────────────────────────────",
    "// The key pair travels over TLS and the gateway verifies it server-side.",
    "const form = new FormData();",
    'form.append("file", fs.createReadStream("annual-report.pdf"), "annual-report.pdf");',
    'form.append("title", "Annual Report 2026");',
    "const response = await fetch(base + \"/api/v1/storage/upload\", {",
    "  method: \"POST\",",
    "  headers: { \"X-AM-Storage-Key-Id\": keyId, \"X-AM-Storage-Key-Secret\": keySecret },",
    "  body: form,",
    "});",
    "const result = await response.json();",
    "// result.data.file → permanent metadata record (id, title, size, retention, status)",
    "// result.data.url  → temporary signed PDF URL returned to your visitors",
    "",
    "// ── 2) HMAC signed mode (secret is never sent after setup) ───────────",
    "// Build the multipart body yourself (e.g. the `form-data` package) so the",
    "// exact bytes being signed are known:",
    "const bodyBytes = await buildMultipartBytes(file, title);",
    "const timestamp = Math.floor(Date.now() / 1000);",
    "const bodyHash = createHash(\"sha256\").update(bodyBytes).digest(\"hex\");",
    "const signature = createHmac(\"sha256\", keySecret)",
    "  .update(`${timestamp}:${bodyHash}`) // signed string: <timestamp>:<sha256hex(body)>",
    "  .digest(\"hex\");",
    "await fetch(base + \"/api/v1/storage/upload\", {",
    "  method: \"POST\",",
    "  headers: {",
    "    \"X-AM-Storage-Key-Id\": keyId,",
    "    \"X-AM-Storage-Timestamp\": String(timestamp),",
    "    \"X-AM-Storage-Signature\": signature,",
    "  },",
    "  body: bodyBytes,",
    "});",
  ].join("\n");

  return (
    <div className="space-y-6">
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wider text-ngo-600">AM Storage Company · Storage Bridge</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-ink-900 sm:text-3xl">API Management</h1>
          <p className="mt-2 max-w-2xl text-sm text-slate-600">
            Generate and revoke dual-token API credentials for gramunnayan.com. Each credential is an{" "}
            <strong>API Key ID</strong> (visible) plus an <strong>API Secret Key</strong> (shown once, like Cloudflare R2). The bridge
            verifies both server-to-server against the gateway registry. R2 credentials are never exposed to the client site.
          </p>
        </div>
      </header>

      {error && <Notice type="error">{error}</Notice>}

      {bridgeUrl !== DEFAULT_BRIDGE_URL ? (
        <Notice type="info">
          Integration endpoint: <code className="font-mono text-xs">POST {bridgeUrl}/api/v1/storage/upload</code>.{" "}
          <strong>This must be the FastAPI bridge origin, not the Next.js gateway origin.</strong> If it points to the
          gateway, integrations receive a 404 HTML page.
        </Notice>
      ) : (
        <Notice type="warning">
          <strong>NEXT_PUBLIC_BRIDGE_URL is not set in this build.</strong> The snippets below use the placeholder{" "}
          {bridgeUrl}. Set it to the deployed FastAPI bridge origin before sharing credentials with gramunnayan.com.
        </Notice>
      )}

      {newCredential && (
        <Notice type="warning">
          <strong>Copy both parts now — the API Secret Key cannot be displayed again.</strong> Send them to the gramunnayan.com
          server over a private channel and store them in its environment (never in browser code or client bundles).
          <div className="mt-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wide text-amber-800">Key ID (visible)</span>
              <code className="break-all rounded bg-amber-100 px-2 py-1 font-mono text-sm font-bold">{newCredential.keyId}</code>
              <Button variant="secondary" onClick={() => void copy(newCredential.keyId, "key-id")}>
                {copied === "key-id" ? <Check className="h-4 w-4" /> : <Clipboard className="h-4 w-4" />}
                {copied === "key-id" ? "Copied" : "Copy"}
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wide text-amber-800">Secret (once only)</span>
              <code className="break-all rounded bg-amber-100 px-2 py-1 font-mono text-sm font-bold">{newCredential.keySecret}</code>
              <Button variant="secondary" onClick={() => void copy(newCredential.keySecret, "key-secret")}>
                {copied === "key-secret" ? <Check className="h-4 w-4" /> : <Clipboard className="h-4 w-4" />}
                {copied === "key-secret" ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
        </Notice>
      )}

      <section className="panel p-5 sm:p-6">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <h2 className="flex items-center gap-2 font-bold text-ink-900"><ShieldCheck className="h-5 w-5 text-ngo-600" />Custom API credentials</h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
              Credentials are prefixed <code className="font-mono text-xs">am_store_live_</code> (ID) and{" "}
              <code className="font-mono text-xs">am_sec_live_</code> (secret), high-entropy, and stored only as a SHA-256 digest
              (plus an encrypted copy that enables HMAC signed mode). Revoking a credential takes effect immediately on the next
              bridge request.
            </p>
          </div>
          <Button onClick={() => void generate()} disabled={generating} className="shrink-0">
            <Plus className="h-4 w-4" />{generating ? "Generating…" : "Generate API key"}
          </Button>
        </div>

        {keys.length === 0 ? (
          <p className="mt-5 rounded-lg border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500">
            No API credentials yet. Generate the first key pair for gramunnayan.com above.
          </p>
        ) : (
          <ul className="mt-5 divide-y divide-slate-100">
            {keys.map((key) => (
              <li className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between" key={key.id}>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <KeyRound className="h-4 w-4 shrink-0 text-ngo-600" />
                    <code className="break-all font-mono text-sm font-semibold text-ink-900">{key.keyId ?? `${key.prefix}••••••`}</code>
                    {key.keyId === null && <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-bold text-slate-600">Legacy</span>}
                    {key.revokedAt
                      ? <span className="rounded bg-red-50 px-2 py-0.5 text-xs font-bold text-red-700">Revoked</span>
                      : <span className="rounded bg-ngo-50 px-2 py-0.5 text-xs font-bold text-ngo-700">Active</span>}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    Created {formatDate(key.createdAt)} · {key.lastUsedAt ? `Last used ${formatDate(key.lastUsedAt)}` : "Never used"}
                    {key.keyId ? " · secret hidden (digest only)" : ""}
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
          The NGO website sends multipart form data with one PDF per request to the unified public gateway endpoint. Pass{" "}
          <strong>both identifiers</strong> —{" "}
          <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs">X-AM-Storage-Key-Id</code> and{" "}
          <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs">X-AM-Storage-Key-Secret</code> — or use{" "}
          <strong>HMAC signed mode</strong> (<code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs">X-AM-Storage-Signature</code> +{" "}
          <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs">X-AM-Storage-Timestamp</code>) so the raw secret is
          never sent after initial setup. The bridge validates the credential, streams the PDF to private Cloudflare R2, registers
          the document, and returns a signed URL.
        </p>

        <div className="mt-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-bold text-ink-900">1 · cURL (dual-token, quick test)</p>
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
          <code className="rounded bg-blue-100 px-1.5 py-0.5 font-mono text-xs">AM_STORAGE_KEY_ID</code> and{" "}
          <code className="rounded bg-blue-100 px-1.5 py-0.5 font-mono text-xs">AM_STORAGE_KEY_SECRET</code> (and the Cloudflare R2
          credentials) out of browser JavaScript. Signed requests expire after a 5-minute clock-skew window, which blocks replay of
          captured requests. Visitors should only ever receive the signed PDF URL the bridge returns.
        </Notice>
      </section>
    </div>
  );
}
