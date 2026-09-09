# AM Storage Company — Storage Bridge (FastAPI)

The **Storage Bridge** is the public, high-concurrency API boundary that
gramunnayan.com uses to hand PDFs to **AM Storage Company**. It runs as its own
async FastAPI service (uvicorn) next to the AM Storage gateway (Next.js
control plane + Firestore metadata + dashboard), and it is the only component
that talks directly to the NGO site with a dashboard-managed Custom API Key.

```text
gramunnayan.com (server)
      │  POST multipart PDF + X-AM-Storage-Key: am_store_live_…
      ▼
┌───────────────────────────  AM Storage Bridge (FastAPI) ──────────────────────┐
│ 1. Validates the Custom API Key via the gateway registry (revocation-aware)   │
│ 2. Structural PDF gate: .pdf, application/pdf, %PDF header, %%EOF trailer    │
│ 3. Streams bytes into private Cloudflare R2 (R2_* env — never client-facing) │
│ 4. HEAD-verifies the stored object, then registers metadata with the gateway │
│ 5. Returns { file, url } — url is a short-lived signed PDF URL               │
└───────────────┬───────────────────────────────────────────────┬──────────────┘
                │ X-Storage-Gateway-Key (server-to-server)       │ R2 credentials only here
                ▼                                               ▼
      AM Storage gateway (Next.js)                   Cloudflare R2 (private bucket)
      Firestore metadata · audit · retention
```

The dashboard generates, lists, and revokes the `am_store_live_*` keys under
**Admin → API Management**. Bridge uploads become normal active documents: they
appear in the dashboard Files view, obey default retention, flow into Trash and
cleanup, and are served by the gateway listing/download endpoints.

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

## Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `STORAGE_GATEWAY_URL` | yes (registry mode) | `http://localhost:3000` | Base URL of the AM Storage gateway |
| `INTEGRATION_API_KEY` | yes (registry mode) | — | Server-to-server secret, identical to the gateway's `INTEGRATION_API_KEY` |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET_NAME` / `R2_ENDPOINT` | yes | — | Private Cloudflare R2 credentials used to stream/uploads and sign URLs |
| `AM_STORAGE_KEYS` | optional | — | Comma-separated static keys accepted locally without a gateway round-trip (self-hosted mode) |
| `AM_STORAGE_MAX_PDF_BYTES` | optional | `52428800` | Hard per-file cap; should match the gateway setting |
| `AM_STORAGE_SIGNED_URL_EXPIRY_SECONDS` | optional | `3600` | Lifetime of signed PDF URLs returned to the NGO site |
| `CORS_ORIGINS` | optional | `https://gramunnayan.com,https://www.gramunnayan.com` | Browser origins allowed to call the bridge |

Keys generated in the dashboard are stored in Firestore (SHA-256 digests only);
the bridge verifies them through the gateway, so revocation is immediate and the
bridge never needs Firebase credentials.

## Endpoints

All endpoints (except `/health`) require the header
`X-AM-Storage-Key: am_store_live_…` (Custom API Key from the dashboard).

### `POST /api/v1/storage/upload` — the unified gateway endpoint

Multipart form data with a `file` field (PDF only). Optional fields: `title`,
`description`, `category`, `tags` (comma-separated or JSON array).

```bash
curl -X POST https://bridge.your-domain.example/api/v1/storage/upload \
  -H 'X-AM-Storage-Key: am_store_live_xxxxxx' \
  -F 'file=@annual-report.pdf' \
  -F 'title=Annual Report 2026'
```

Success `201`:

```json
{
  "success": true,
  "data": {
    "file": {
      "id": "f5x…", "originalName": "annual-report.pdf", "title": "Annual Report 2026",
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

### `GET /api/files` — active PDF metadata (paginated, searchable)

Forwards the same query parameters as the gateway API (`pageSize`, `cursor`,
`search`, `sort`). Only `active` documents are returned.

### `GET /api/files/{file_id}/download?disposition=inline|attachment&redirect=true`

Relays the gateway download: `302` to a signed PDF URL (`redirect=true`) or JSON
with the signed URL.

### `GET /api/files/{file_id}` — single document metadata

### `GET /health` — unauthenticated liveness

## Behavior notes

- Errors use the gateway envelope: `{"success": false, "error": {"code", "message"}, "requestId"}`.
- Every request gets an id (`X-Request-Id`), a structured access log line, and a
  per-IP rate limit. Successful key checks refresh `lastUsedAt` in the dashboard.
- If metadata registration fails after an object was stored, the bridge deletes
  the object (compensation) so no orphaned bytes are left behind.
- For very large/frequent uploads put the bridge behind a proxy and pair the
  in-process limiter with a platform WAF; run multiple uvicorn workers.
