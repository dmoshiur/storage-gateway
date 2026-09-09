# AM Storage Company FastAPI adapter

Run this server beside the NGO website server, never in browser code:

```bash
cd fastapi
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
export STORAGE_GATEWAY_URL=https://your-gateway.example.com
export INTEGRATION_API_KEY='the same server-only key configured in the gateway'
export CORS_ORIGINS=https://ngo.example.com
uvicorn main:app --host 0.0.0.0 --port 8000
```

Endpoints: `GET /health`, `GET /api/files`, and `GET /api/files/{id}`. The adapter adds `X-Storage-Gateway-Key` server-to-server, so the key is never exposed to site visitors. Interactive docs are available at `/docs`.
