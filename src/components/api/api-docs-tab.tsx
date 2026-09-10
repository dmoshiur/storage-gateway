"use client";

import { CodeBlock } from "@/components/ui/data";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card-pad space-y-3">
      <h2 className="section-title">{title}</h2>
      {children}
    </section>
  );
}

function Endpoint({ method, path, scopes, description, example }: {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  scopes: string;
  description: string;
  example?: string;
}) {
  const tone = method === "GET" || method === "DELETE"
    ? "badge-neutral"
    : method === "POST" ? "badge-success" : "badge-info";
  return (
    <div className="rounded-lg border border-line p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`${tone} font-mono`}>{method}</span>
        <code className="font-mono text-[13px] text-ink">{path}</code>
      </div>
      <p className="mt-1.5 text-[13px] text-ink-muted">{description} <span className="font-mono text-xs">Scopes: {scopes}</span></p>
      {example && <div className="mt-2"><CodeBlock code={example} /></div>}
    </div>
  );
}

export function ApiDocsTab() {
  return (
    <div className="space-y-4">
      <Section title="Authentication">
        <p className="text-[13px] leading-6 text-ink-muted">
          Send your key ID and secret with every request, either as headers or query parameters. All keys are
          scoped; requests using a scope the key does not have are rejected with <code className="font-mono text-xs">403</code>.
        </p>
        <CodeBlock
          code={`# Headers (recommended)
curl "https://cloud.your-domain.org/api/bridge/files" \\
  -H "X-AM-Storage-Key-Id: YOUR_KEY_ID" \\
  -H "X-AM-Storage-Key-Secret: YOUR_KEY_SECRET"

# Or query parameters
curl "https://cloud.your-domain.org/api/bridge/files?apiKeyId=YOUR_KEY_ID&apiKeySecret=YOUR_KEY_SECRET"`}
        />
        <p className="text-[13px] leading-6 text-ink-muted">
          Secrets are write-only: they can be created and rotated but never viewed again. Failed authentication
          is rate-limited, waits <code className="font-mono text-xs">429</code> when you exceed limits, and returns
          standard JSON errors: <code className="font-mono text-xs">{"{ error: string, message?: string }"}</code>.
        </p>
      </Section>

      <Section title="Endpoints">
        <div className="space-y-3">
          <Endpoint
            method="GET" path="/api/bridge/files" scopes="files:read"
            description="List active documents. Supports search, category, tag, sort, page, and pageSize."
            example={`curl "https://cloud.your-domain.org/api/bridge/files?search=budget&category=Finance&page=1&pageSize=20" \\
  -H "X-AM-Storage-Key-Id: KEY_ID" -H "X-AM-Storage-Key-Secret: SECRET"`}
          />
          <Endpoint
            method="POST" path="/api/bridge/files" scopes="files:write"
            description="Add a document by URL (PDF only, 50 MB max) or by base64 data."
          />
          <Endpoint
            method="GET" path="/api/bridge/files?id=…" scopes="files:read"
            description="Fetch one document's metadata. Use download or preview for bytes."
          />
          <Endpoint
            method="PATCH" path="/api/bridge/files?id=…" scopes="files:write"
            description="Update title, description, category, tags, or retention policy."
          />
          <Endpoint
            method="DELETE" path="/api/bridge/files?id=…" scopes="files:delete"
            description="Move a document to Trash. Add ?permanent=true with files:permanent_delete to destroy it."
          />
          <Endpoint
            method="GET" path="/api/bridge/files/download?id=…" scopes="files:read"
            description="Stream the PDF bytes with an attachment filename."
          />
          <Endpoint
            method="GET" path="/api/bridge/files/preview?id=…" scopes="files:read"
            description="Get a short-lived signed preview URL for embedding in an iframe."
          />
          <Endpoint
            method="GET" path="/api/bridge/files/download-link?id=…&ttlSeconds=3600" scopes="files:read"
            description="Mint a scoped, temporary download link (60 s – 7 days)."
          />
          <Endpoint
            method="GET" path="/api/bridge/files/favorite" scopes="favorites:read"
            description="List favorite documents for the calling context."
          />
          <Endpoint
            method="POST" path="/api/bridge/files/favorite?id=…" scopes="favorites:write"
            description="Add or remove a favorite with { favorite: true | false }."
          />
          <Endpoint
            method="GET" path="/api/bridge/categories" scopes="files:read"
            description="List categories with file counts."
          />
          <Endpoint
            method="POST" path="/api/bridge/upload" scopes="files:upload"
            description="Three-step direct browser upload: init → PUT to signed URL → complete. Multiparts never touch this server."
            example={`# 1. Init — returns uploadId + signedUrl
curl -X POST "https://cloud.your-domain.org/api/bridge/upload" \\
  -H "X-AM-Storage-Key-Id: KEY_ID" -H "X-AM-Storage-Key-Secret: SECRET" \\
  -H "Content-Type: application/json" \\
  -d '{"action":"init","fileName":"report.pdf","fileSize":102400,"contentType":"application/pdf"}'

# 2. PUT the raw bytes straight to the returned URL
curl -X PUT "<signedUrl>" -H "Content-Type: application/pdf" --data-binary "@report.pdf"

# 3. Complete — validates and registers the document
curl -X POST "https://cloud.your-domain.org/api/bridge/upload" \\
  -H "X-AM-Storage-Key-Id: KEY_ID" -H "X-AM-Storage-Key-Secret: SECRET" \\
  -H "Content-Type: application/json" \\
  -d '{"action":"complete","uploadId":"…","title":"Annual report"}'`}
          />
        </div>
      </Section>

      <Section title="Versioned REST API (/api/v1)">
        <p className="text-[13px] leading-6 text-ink-muted">
          A RESTful alternative to the bridge with HMAC-signed requests: each request carries
          <code className="font-mono text-xs"> X-AM-Key-Id</code>, <code className="font-mono text-xs">X-AM-Timestamp</code>,
          and <code className="font-mono text-xs">X-AM-Signature</code> (HMAC-SHA256 of method, path, timestamp, and body over the secret).
        </p>
        <div className="space-y-3">
          <Endpoint method="GET" path="/api/v1/files" scopes="files:read" description="Cursor-paginated document listing." />
          <Endpoint method="POST" path="/api/v1/files" scopes="files:write" description="Register a document from a signed upload or URL." />
          <Endpoint method="GET" path="/api/v1/files/{id}" scopes="files:read" description="Fetch one document." />
          <Endpoint method="PATCH" path="/api/v1/files/{id}" scopes="files:write" description="Update metadata or retention." />
          <Endpoint method="DELETE" path="/api/v1/files/{id}" scopes="files:delete" description="Trash, or permanently destroy with files:permanent_delete." />
        </div>
      </Section>

      <Section title="Scopes & rate limits">
        <p className="text-[13px] leading-6 text-ink-muted">
          Available scopes: <code className="font-mono text-xs">files:read · files:write · files:upload · files:delete · files:permanent_delete · favorites:read · favorites:write · categories:manage · tags:manage · webhooks:manage · audit:read</code>.
          Requests are rate-limited per key; repeated failures lock the key out briefly to slow brute-force attacks.
        </p>
      </Section>

      <Section title="Webhooks">
        <p className="text-[13px] leading-6 text-ink-muted">
          Subscribe to <code className="font-mono text-xs">file.uploaded · file.updated · file.trashed · file.restored · file.deleted · file.expiring</code> from the
          Webhooks page. Payloads are posted as JSON with an <code className="font-mono text-xs">X-Webhook-Signature</code> HMAC header and
          <code className="font-mono text-xs"> X-Webhook-Event</code> name, with exponential-backoff retries on failure.
        </p>
      </Section>
    </div>
  );
}
