# AM Storage Company — Storage Bridge (FastAPI, optional legacy)

> **New deployments do not need this service.** The Storage Bridge is embedded
> in the Next.js app itself (`POST /api/v1/storage/upload` on the same Vercel
> deployment, plus a presigned init → PUT → complete flow for larger documents).
> This standalone FastAPI bridge remains only for operators who explicitly want
> a separate high-concurrency upload host. Everything below describes that
> optional external deployment.

The standalone **Storage Bridge** is a public, high-concurrency API boundary
that gramunnayan.com can use to hand PDF/DOC/DOCX/TXT/PPT/PPTX documents to
**AM Storage Company**. It runs as its own async FastAPI service (uvicorn) next
to the AM Storage gateway (Next.js control plane + Firestore metadata +
dashboard). Requests are authenticated with the dual-token API credential (key ID + secret,
or an HMAC signature) issued by the dashboard.

When this external bridge is used, point the gateway's `BRIDGE_URL` /
`NEXT_PUBLIC_BRIDGE_URL` and the integration server's `AM_STORAGE_BRIDGE_URL`
at the FastAPI origin, and verify `GET <bridge-origin>/health` returns
`"bridge": "ready"`. Otherwise leave those variables unset and the embedded
bridge serves all `/api/v1/*` traffic on the Vercel app itself.

```text
gramunnayan.com (server)
      |  POST multipart document + dual-token credential
      |    X-AM-Storage-Key-Id + X-AM-Storage-Key-Secret
      |    (or HMAC signed: X-AM-Storage-Signature + X-AM-Storage-Timestamp)
      v
+--------------------------------------------------------------+
|  AM Storage Bridge (FastAPI)                                 |
| 1. Validates the API credential via the gateway registry     |
|    (revocation-aware; digest or HMAC)                        |
| 2. Structural document gate: PDF/DOC/DOCX/TXT/PPT/PPTX       |
| 3. Streams bytes into private Cloudflare R2 (never client)   |
| 4. HEAD-verifies the object, registers metadata w/ gateway   |
| 5. Logs the attempt (success OR failure) to the dashboard    |
| 6. Returns { file, url } - url is a short-lived signed URL   |
+------------+-----------------------------+------------------+
             | X-Storage-Gateway-Key          | R2 credentials
             | (server-to-server)             | only here
             v                                v
  AM Storage gateway (Next.js)      Cloudflare R2 (private bucket)
  Firestore metadata / audit /
  retention / API activity log
```

The dashboard generates, lists, and revokes the dual-token credentials under
**Admin -> API Management**: a visible **API Key ID** (`am_store_live_...`) plus
an **API Secret Key** (`am_sec_live_...`) displayed exactly once at generation
(Cloudflare R2 style). Bridge uploads become normal active documents: they
appear in the dashboard Files view, obey default retention, flow into Trash and
cleanup, and are served by the gateway listing/download endpoints. Every
upload attempt - including rejected ones - shows up in the dashboard's
"API Upload Activity" log with a Success/Failed badge.

## Run it

Requires Python 3.10+:

```bash
cd fastapi
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt

# The gateway (Next.js) that owns metadata + the key registry:
export STORAGE_GATEWAY_URL=https://your-gateway.example.com
export INTEGRATION_API_KEY='the same server-only secret configured in the gateway'

# Private Cloudflare R2 credentials (never exposed to gramunnayan.com):
export R2_ACCOUNT_ID=your-cloudflare-account-id
export R2_ACCESS_KEY_ID=your-r2-access-key-id
export R2_SECRET_ACCESS_KEY=your-r2-secret-access-key
export R2_BUCKET_NAME=your-bucket
export R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com

uvicorn main:app --host 0.0.0.0 --port 8000 --workers 4
```

Interactive OpenAPI docs: <http://localhost:8000/docs>.

### Docker / Render / Railway / VPS

A `fastapi/Dockerfile` is included. Build and run it on the bridge host:

```bash
cd fastapi
docker build -t am-storage-bridge .
docker run -p 8000:8000 --env-file .env am-storage-bridge
```

For Railway or a VPS, publish port `8000`, map a public TLS origin
(e.g. `https://bridge.gusb.example.org`), and wire that origin into
`AM_STORAGE_BRIDGE_URL` / `NEXT_PUBLIC_BRIDGE_URL` / `BRIDGE_URL`.

For Render, the repository root contains a [`render.yaml`](../render.yaml)
Blueprint that builds this Dockerfile with `rootDir: fastapi`, a `/health`
health check, and every secret prompted at deploy time. Point Render at the
repository, apply the Blueprint, then set the resulting service URL as the
bridge origin on the gateway and on gramunnayan.com.

Whichever host you choose, complete the routing step before go-live:

1. `GET https://<bridge-origin>/health` returns `{"status":"ok","bridge":"ready",...}`.
2. The gateway has `NEXT_PUBLIC_BRIDGE_URL` and `BRIDGE_URL` set to
   `https://<bridge-origin>` (must **not** be the gateway host).
3. gramunnayan.com's server has `AM_STORAGE_BRIDGE_URL=https://<bridge-origin>`.
4. `POST https://<bridge-origin>/api/v1/storage/upload` with a real PDF/PPTX
   returns JSON (`201` when R2 is configured, or a structured JSON error) —
   never an HTML 404.

## Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `STORAGE_GATEWAY_URL` | yes (registry mode) | `http://localhost:3000` | Base URL of the AM Storage gateway |
| `INTEGRATION_API_KEY` | yes (registry mode) | — | Server-to-server secret, identical to the gateway's `INTEGRATION_API_KEY` |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET_NAME` / `R2_ENDPOINT` | yes | — | Private Cloudflare R2 credentials used to stream/uploads and sign URLs |
| `AM_STORAGE_KEYS` | optional | — | Comma-separated static keys accepted locally without a gateway round-trip (self-hosted mode) |
| `AM_STORAGE_MAX_DOCUMENT_BYTES` | optional | `52428800` | Hard per-file cap for PDF/DOC/DOCX/TXT/PPT/PPTX; should match the gateway setting (`AM_STORAGE_MAX_PDF_BYTES` remains accepted for existing deployments) |
| `AM_STORAGE_SIGNED_URL_EXPIRY_SECONDS` | optional | `3600` | Lifetime of signed document URLs returned to the NGO site |
| `CORS_ORIGINS` | optional | `https://gramunnayan.com,https://www.gramunnayan.com` | Browser origins allowed to call the bridge |

Credentials generated in the dashboard are stored in Firestore as SHA-256
digests (plus an AES-256-GCM encrypted copy when the gateway has
`AM_STORAGE_MASTER_KEY` configured); the bridge verifies them through the
gateway, so revocation is immediate and the bridge never needs Firebase
credentials.

## Endpoints

All endpoints (except `/health`) require one of these credentials (in priority
order):

1. **Dual-token (recommended)** — `X-AM-Storage-Key-Id: am_store_live_…`
   plus `X-AM-Storage-Key-Secret: am_sec_live_…`
2. **HMAC signed** — `X-AM-Storage-Key-Id` plus
   `X-AM-Storage-Timestamp` (unix seconds, ±5 minute window) plus
   `X-AM-Storage-Signature` = `HMAC-SHA256(keySecret,
   "<timestamp>:<sha256hex(raw body bytes)>")` as lowercase hex. The raw
   secret is never transmitted after initial setup.
3. **Legacy single key** — `X-AM-Storage-Key: am_store_live_…`
   (pre-upgrade integrations; rotate to dual-token)

Self-hosted mode: keys listed in `AM_STORAGE_KEYS` are accepted locally
(legacy header, or as the dual-token secret) without a gateway round-trip.

### `POST /api/v1/storage/upload` — the unified gateway endpoint

Multipart form data with a `file` field for **PDF, DOC, DOCX, TXT, PPT, or
PPTX**. Optional fields: `title`, `description`, `category`, `tags`
(comma-separated or JSON array).

```bash
curl -X POST https://bridge.your-domain.example/api/v1/storage/upload \
  -H 'X-AM-Storage-Key-Id: am_store_live_xxxxxx' \
  -H 'X-AM-Storage-Key-Secret: am_sec_live_yyyyyy' \
  -F 'file=@annual-report.pdf' \
  -F 'title=Annual Report 2026'

# PPTX example
curl -X POST https://bridge.your-domain.example/api/v1/storage/upload \
  -H 'X-AM-Storage-Key-Id: am_store_live_xxxxxx' \
  -H 'X-AM-Storage-Key-Secret: am_sec_live_yyyyyy' \
  -F 'file=@governance-slides.pptx' \
  -F 'title=Governance slides 2026'
```

Success `201`:

```json
{
  "success": true,
  "data": {
    "file": {
      "id": "f5x…", "originalName": "annual-report.pdf", "title": "Annual Report 2026",
      "mimeType": "application/pdf", "extension": "pdf",
      "size": 432100, "status": "active", "createdAt": "2026-09-09T12:00:00.000Z",
      "autoDeleteEnabled": false, "retentionType": "6_months"
    },
    "url": "https://…r2.cloudflarestorage.com/…?X-Amz-Signature=…",
    "expiresAt": "2026-09-09T13:00:00Z",
    "filename": "annual-report.pdf",
    "size": 432100
  },
  "requestId": "…"
}
```

The signed `url` is what gramunnayan.com should show its visitors. It expires
after `AM_STORAGE_SIGNED_URL_EXPIRY_SECONDS`; the canonical file id can be used
with `GET /api/files/{id}/download` to mint new URLs.

### `GET /api/files` — active document metadata (paginated, searchable)

Forwards the same query parameters as the gateway API (`pageSize`, `cursor`,
`search`, `sort`). Only `active` documents are returned.

### `GET /api/files/{file_id}/download?disposition=inline|attachment&redirect=true`

Relays the gateway download: `302` to a signed document URL (`redirect=true`) or JSON
with the signed URL.

### `GET /api/files/{file_id}` — single document metadata

### `GET /health` — unauthenticated liveness

## Behavior notes

### Troubleshooting: Next.js 404 HTML on `POST /api/v1/storage/upload`

A 404 response containing `<!DOCTYPE html>` / `/_next/static/...` means the
request reached the **Next.js gateway (Vercel)** instead of this **FastAPI
bridge**.

`POST /api/v1/storage/upload` is a bridge route (defined in `app/main.py` as
`UPLOAD_PATH`). The gateway does not parse document bytes itself; it exposes an
optional compatibility proxy at `/api/v1/storage/upload` that streams the
upload to the configured `BRIDGE_URL` / `NEXT_PUBLIC_BRIDGE_URL` origin. A
custom domain pointing to Vercel (e.g. `https://st.thamjj13.top`, CNAME to a
`*.vercel-dns-*.com` host) returns the JSON 404
(`BRIDGE_ENDPOINT_NOT_AT_GATEWAY`) for `/api/v1/*` when no bridge origin is
configured, or JSON `502 BRIDGE_UNAVAILABLE` if the configured bridge is down.

To resolve the integration:

1. Deploy/start this FastAPI bridge on its own host (`uvicorn main:app --host
   0.0.0.0 --port 8000 --workers 4`).
2. Set `NEXT_PUBLIC_BRIDGE_URL` / `BRIDGE_URL` on the gateway and
   `AM_STORAGE_BRIDGE_URL` on the NGO website server to that bridge origin (for
   example `https://bridge.example.org`), not to the gateway host.
3. Confirm with `GET <bridge-origin>/health` — it must return
   `{"status":"ok","bridge":"ready",...}`.
4. Re-run the upload call against `<bridge-origin>/api/v1/storage/upload`. The
   gateway proxy can also be used as long as `BRIDGE_URL` points here; it
   preserves the JSON body, status, and `requestId`.

- Errors use the gateway envelope: `{"success": false, "error": {"code", "message"}, "requestId"}`.
- Every request gets an id (`X-Request-Id`), a structured access log line, and a
  per-IP rate limit. Successful credential checks refresh `lastUsedAt` and
  increment the dashboard's per-day API request counter.
- Every upload attempt (success **and** failure) is reported to
  `POST /api/internal/bridge/upload-logs`, which powers the dashboard's
  "API Upload Activity" widget with Success/Failed badges. This call is
  best-effort: a logging failure never changes the upload outcome.
- If metadata registration fails after an object was stored, the bridge deletes
  the object (compensation) so no orphaned bytes are left behind.
- HMAC signed mode is only verifiable when the gateway has `AM_STORAGE_MASTER_KEY`
  configured (the secret is stored AES-256-GCM encrypted). Without it, use the
  dual-token headers. Signed timestamps are rejected outside a ±5-minute window.
- For very large/frequent uploads put the bridge behind a proxy and pair the
  in-process limiter with a platform WAF; run multiple uvicorn workers.
