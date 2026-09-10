"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { V1_ENDPOINTS, endpointUrl, type EndpointDef } from "@/lib/api/endpoints";
import { CodeBlock, CopyButton } from "@/components/ui/data";

function MethodBadge({ method }: { method: EndpointDef["method"] }) {
  const tone = method === "GET" ? "badge-info" : method === "POST" ? "badge-success" : method === "PATCH" ? "badge-warning" : "badge-danger";
  return <span className={`${tone} font-mono`}>{method}</span>;
}

function curlExample(baseUrl: string, def: EndpointDef): string {
  const url = endpointUrl(baseUrl, def).replace(":id", "FILE_ID");
  const lines = [`curl -X ${def.method} "${url}"`, `  -H "Authorization: Bearer ng_live_YOUR_API_KEY"`];
  if (def.requestBody?.includes("multipart/form-data")) {
    lines.push(`  -F "file=@./report.pdf"`);
  } else if (def.method === "POST" || def.method === "PATCH") {
    lines.push(`  -H "Content-Type: application/json"`);
    lines.push(`  -d '${(def.requestBody ?? "{}").replace(/\n/g, " ").replace(/  +/g, " ")}'`);
  }
  return lines.join(" \\\n");
}

function jsExample(baseUrl: string, def: EndpointDef): string {
  const url = endpointUrl(baseUrl, def).replace(":id", "FILE_ID");
  const method = def.method;
  if (def.requestBody?.includes("multipart/form-data")) {
    return `const form = new FormData();
form.append("file", fileInput.files[0]);

const res = await fetch("${url}", {
  method: "${method}",
  headers: { Authorization: "Bearer ng_live_YOUR_API_KEY" },
  body: form,
});
const json = await res.json();`;
  }
  const body = def.method === "POST" || def.method === "PATCH" ? `\n  body: JSON.stringify(${def.requestBody ?? "{}"}),` : "";
  return `const res = await fetch("${url}", {
  method: "${method}",
  headers: {
    Authorization: "Bearer ng_live_YOUR_API_KEY",
    "Content-Type": "application/json",
  },${body}
});
const json = await res.json();`;
}

function EndpointCard({ def, baseUrl }: { def: EndpointDef; baseUrl: string }) {
  const [open, setOpen] = useState(false);
  const url = endpointUrl(baseUrl, def);

  return (
    <div className="rounded-lg border border-line">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3.5 py-3 text-left hover:bg-surface-sunken"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <MethodBadge method={def.method} />
        <code className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink">{def.path}</code>
        {def.scope && <span className="hidden font-mono text-[11px] text-ink-faint sm:inline">{def.scope}</span>}
        {open ? <ChevronUp className="h-4 w-4 shrink-0 text-ink-faint" /> : <ChevronDown className="h-4 w-4 shrink-0 text-ink-faint" />}
      </button>
      {open && (
        <div className="space-y-4 border-t border-line px-3.5 py-4">
          <p className="text-[13px] leading-6 text-ink-muted">{def.description}</p>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-ink-faint">Endpoint URL</span>
            <code className="font-mono text-xs text-ink">{url}</code>
            <CopyButton value={url} label="Copy endpoint" />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-ink-faint">Authentication</p>
              <p className="mt-1 font-mono text-xs text-ink">Authorization: Bearer {"<API_KEY>"}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-ink-faint">Required scope</p>
              <p className="mt-1 font-mono text-xs text-ink">{def.scope ?? "— (unauthenticated)"}</p>
            </div>
          </div>

          {def.params.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-ink-faint">Parameters</p>
              <div className="mt-1.5 overflow-x-auto rounded-lg border border-line">
                <table className="w-full border-collapse text-left text-xs">
                  <thead className="bg-surface-sunken">
                    <tr>
                      <th className="px-2.5 py-1.5 font-mono font-medium text-ink-muted">Name</th>
                      <th className="px-2.5 py-1.5 font-mono font-medium text-ink-muted">In</th>
                      <th className="px-2.5 py-1.5 font-mono font-medium text-ink-muted">Required</th>
                      <th className="px-2.5 py-1.5 font-medium text-ink-muted">Description</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {def.params.map((param) => (
                      <tr key={param.name}>
                        <td className="px-2.5 py-1.5 font-mono text-ink">{param.name}</td>
                        <td className="px-2.5 py-1.5 text-ink-muted">{param.in}</td>
                        <td className="px-2.5 py-1.5 text-ink-muted">{param.required ? "yes" : "no"}</td>
                        <td className="px-2.5 py-1.5 text-ink-muted">{param.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {def.requestBody && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-ink-faint">Request body</p>
              <div className="mt-1.5"><CodeBlock code={def.requestBody} language="request" /></div>
            </div>
          )}

          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-ink-faint">Response</p>
            <div className="mt-1.5"><CodeBlock code={def.responseExample} language="json" /></div>
          </div>

          {def.errorResponses.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-ink-faint">Error responses</p>
              <div className="mt-1.5 space-y-1">
                {def.errorResponses.map((err) => (
                  <p key={err.code} className="text-xs text-ink-muted">
                    <span className="badge-danger font-mono">{err.status}</span>{" "}
                    <span className="font-mono">{err.code}</span> — {err.description}
                  </p>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <CopyButton value={curlExample(baseUrl, def)} label="Copy cURL" />
            <button type="button" className="btn-secondary btn-sm" onClick={() => navigator.clipboard.writeText(jsExample(baseUrl, def))}>Copy JavaScript</button>
          </div>

          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-ink-faint">cURL</p>
            <div className="mt-1.5"><CodeBlock code={curlExample(baseUrl, def)} language="bash" /></div>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-ink-faint">JavaScript</p>
            <div className="mt-1.5"><CodeBlock code={jsExample(baseUrl, def)} language="javascript" /></div>
          </div>
        </div>
      )}
    </div>
  );
}

export function ApiDocsTab({ baseUrl }: { baseUrl: string }) {
  const origin = baseUrl || "https://YOUR-PRODUCTION-DOMAIN";

  return (
    <div className="space-y-4">
      <section className="card-pad space-y-3">
        <h2 className="section-title">Authentication</h2>
        <p className="text-[13px] leading-6 text-ink-muted">
          Every request to <code className="font-mono text-xs">/api/v1</code> is authenticated with an API key sent as a bearer token.
          Keys are scoped; a request that uses a scope the key does not have receives <code className="font-mono text-xs">403</code>.
        </p>
        <CodeBlock
          code={`curl "${origin}/api/v1/files" \\
  -H "Authorization: Bearer ng_live_YOUR_API_KEY"`}
        />
        <p className="text-[13px] leading-6 text-ink-muted">
          Secrets are write-only: they can be created and rotated but never viewed again. Failed authentication is
          rate-limited, and every error response includes a <code className="font-mono text-xs">requestId</code> for
          production debugging.
        </p>
      </section>

      <section className="card-pad space-y-3">
        <h2 className="section-title">Endpoints</h2>
        <p className="text-[13px] text-ink-muted">
          Only endpoints that are implemented and deployed are listed here.
        </p>
        <div className="space-y-2">
          {V1_ENDPOINTS.map((def) => (
            <EndpointCard key={`${def.method} ${def.path}`} def={def} baseUrl={origin} />
          ))}
        </div>
      </section>

      <section className="card-pad space-y-3">
        <h2 className="section-title">Example: search</h2>
        <p className="text-[13px] text-ink-muted">Search active files by free text:</p>
        <CodeBlock
          code={`curl "${origin}/api/v1/files?search=annual-report" \\
  -H "Authorization: Bearer ng_live_YOUR_API_KEY"`}
        />
      </section>

      <section className="card-pad space-y-3">
        <h2 className="section-title">Scopes</h2>
        <p className="text-[13px] leading-6 text-ink-muted">
          Available scopes: <code className="font-mono text-xs">files:read · files:upload · files:update · files:download · files:delete · metadata:read · metadata:write</code>.
          Assign the smallest set an integration needs.
        </p>
      </section>
    </div>
  );
}
