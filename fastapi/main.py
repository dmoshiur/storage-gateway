"""AM Storage Company integration API.

The Next.js app remains the admin UI and storage authority. This small FastAPI
service is the recommended server-side adapter for an NGO website: it keeps the
integration key off the browser and forwards only the documented read endpoints.
"""
import os
from typing import Any
import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

GATEWAY_URL = os.getenv("STORAGE_GATEWAY_URL", "http://localhost:3000").rstrip("/")
INTEGRATION_KEY = os.getenv("INTEGRATION_API_KEY", "")
app = FastAPI(title="AM Storage Company API", version="1.0.0")
origins = [x.strip() for x in os.getenv("CORS_ORIGINS", "").split(",") if x.strip()]
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET"], allow_headers=["*"])

@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "AM Storage Company"}

async def gateway_get(path: str, params: dict[str, Any] | None = None) -> Any:
    if not INTEGRATION_KEY:
        raise HTTPException(503, "INTEGRATION_API_KEY is not configured")
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.get(f"{GATEWAY_URL}{path}", params=params, headers={"X-Storage-Gateway-Key": INTEGRATION_KEY})
    except httpx.HTTPError as exc:
        raise HTTPException(502, "Storage gateway is unavailable") from exc
    if response.status_code >= 400:
        raise HTTPException(response.status_code, "Storage gateway request failed")
    return response.json()

@app.get("/api/files")
async def files(request: Request) -> Any:
    params = dict(request.query_params)
    params["status"] = "active"
    return await gateway_get("/api/files", params)

@app.get("/api/files/{file_id}")
async def file(file_id: str) -> Any:
    return await gateway_get(f"/api/files/{file_id}")
