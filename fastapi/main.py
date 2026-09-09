"""High-concurrency AM Storage Company Storage Bridge."""
import os, uuid
from typing import Any
import httpx
import aioboto3
from fastapi import FastAPI, HTTPException, Request, UploadFile, File, Depends
from fastapi.middleware.cors import CORSMiddleware

GATEWAY_URL = os.getenv("STORAGE_GATEWAY_URL", "http://localhost:3000").rstrip("/")
INTEGRATION_KEY = os.getenv("INTEGRATION_API_KEY", "")
# Comma-separated active custom keys, supplied by the secret manager in production.
CUSTOM_KEYS = {x.strip() for x in os.getenv("AM_STORAGE_KEYS", "").split(",") if x.strip()}
app = FastAPI(title="AM Storage Company Storage Bridge", version="1.0.0")
origins = [x.strip() for x in os.getenv("CORS_ORIGINS", "https://gramunnayan.com").split(",") if x.strip()]
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET", "POST"], allow_headers=["X-AM-Storage-Key", "Content-Type"])

@app.get("/health")
async def health(): return {"status": "ok", "service": "AM Storage Company", "bridge": "ready"}

async def custom_key(request: Request):
    supplied = request.headers.get("X-AM-Storage-Key", "")
    if not supplied or supplied not in CUSTOM_KEYS:
        raise HTTPException(401, "Invalid or revoked AM Storage key")
    return supplied

@app.post("/api/v1/storage/upload")
async def upload(file: UploadFile = File(...), _: str = Depends(custom_key)):
    if file.content_type != "application/pdf" or not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(415, "Only PDF files are accepted")
    account = os.getenv("R2_ACCOUNT_ID"); bucket = os.getenv("R2_BUCKET_NAME")
    if not all([account, bucket, os.getenv("R2_ACCESS_KEY_ID"), os.getenv("R2_SECRET_ACCESS_KEY")]):
        raise HTTPException(503, "R2 storage is not configured")
    key = f"bridge/{uuid.uuid4()}.pdf"
    session = aioboto3.Session()
    try:
        async with session.client("s3", endpoint_url=os.getenv("R2_ENDPOINT"), aws_access_key_id=os.getenv("R2_ACCESS_KEY_ID"), aws_secret_access_key=os.getenv("R2_SECRET_ACCESS_KEY"), region_name="auto") as s3:
            await s3.upload_fileobj(file.file, bucket, key, ExtraArgs={"ContentType": "application/pdf"})
            url = await s3.generate_presigned_url("get_object", Params={"Bucket": bucket, "Key": key}, ExpiresIn=600)
    except Exception as exc: raise HTTPException(502, "PDF upload failed") from exc
    return {"success": True, "data": {"key": key, "url": url, "filename": file.filename}, "requestId": str(uuid.uuid4())}

async def gateway_get(path: str, params: dict[str, Any] | None = None) -> Any:
    if not INTEGRATION_KEY: raise HTTPException(503, "INTEGRATION_API_KEY is not configured")
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.get(f"{GATEWAY_URL}{path}", params=params, headers={"X-Storage-Gateway-Key": INTEGRATION_KEY})
    except httpx.HTTPError as exc: raise HTTPException(502, "Storage gateway is unavailable") from exc
    if response.status_code >= 400: raise HTTPException(response.status_code, "Storage gateway request failed")
    return response.json()

@app.get("/api/files")
async def files(request: Request):
    params = dict(request.query_params); params["status"] = "active"; return await gateway_get("/api/files", params)

@app.get("/api/files/{file_id}")
async def file(file_id: str): return await gateway_get(f"/api/files/{file_id}")
