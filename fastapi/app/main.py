"""AM Storage Company Storage Bridge — FastAPI application.

gramunnayan.com talks only to this public API. The bridge:

1. validates the dashboard-managed Custom API Key (X-AM-Storage-Key header),
2. streams multipart PDF uploads into private Cloudflare R2,
3. registers the verified document with the AM Storage gateway (metadata,
   retention, audit), and
4. returns a signed, expiring PDF URL — the only R2 artifact the client sees.

R2 and gateway secrets live exclusively in this process; they are never shared
with the client website or its visitors.
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from .config import get_settings
from .gateway import GatewayRejected, GatewayUnavailable, gateway_get, register_file_with_gateway
from .pdf import assert_pdf_metadata, validate_and_sniff_pdf
from .responses import fail, ok
from .r2 import build_object_key, delete_object, presigned_get_url, upload_pdf_object
from .security import client_ip, masked_key, request_id_from, require_custom_api_key

logger = logging.getLogger("am-storage-bridge")

VERSION = "2.0.0"
SERVICE = "AM Storage Company"
BRIDGE = "AM Storage Bridge"

app = FastAPI(
    title=f"{BRIDGE} API",
    description="Public PDF Storage Bridge for gramunnayan.com. Authenticate with the "
    "X-AM-Storage-Key header using a Custom API Key generated in the AM Storage "
    "Company dashboard. R2 credentials are never exposed to client sites.",
    version=VERSION,
)

_settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(_settings.cors_origins),
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["X-AM-Storage-Key", "Content-Type", "X-Request-Id"],
)


# --------------------------------------------------------------------------- #
# Error envelope + access logging
# --------------------------------------------------------------------------- #

@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    request_id = getattr(request.state, "request_id", request_id_from(request))
    detail = exc.detail if isinstance(exc.detail, dict) else {"code": "REQUEST_FAILED", "message": str(exc.detail or "Request failed.")}
    return fail(
        str(detail.get("code", "REQUEST_FAILED")),
        str(detail.get("message", "The request could not be completed.")),
        request_id,
        exc.status_code,
    )


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    request_id = getattr(request.state, "request_id", request_id_from(request))
    first = exc.errors()[0] if exc.errors() else {}
    location = ".".join(str(part) for part in first.get("loc", ["body"]))
    message = first.get("msg", "The request is invalid.")
    return fail("VALIDATION_ERROR", f"{location}: {message}", request_id, 422)


@app.middleware("http")
async def observe_requests(request: Request, call_next: Any) -> Response:
    request.state.request_id = request_id_from(request)
    started = time.perf_counter()

    response = await call_next(request)

    duration_ms = round((time.perf_counter() - started) * 1000, 1)
    supplied_key = request.headers.get("X-AM-Storage-Key")
    logger.info(
        json.dumps({
            "event": "bridge_access",
            "requestId": request.state.request_id,
            "method": request.method,
            "path": request.url.path,
            "status": response.status_code,
            "durationMs": duration_ms,
            "ip": client_ip(request),
            "key": masked_key(supplied_key) if supplied_key else None,
        })
    )
    response.headers["X-Request-Id"] = request.state.request_id
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


# --------------------------------------------------------------------------- #
# Public endpoints
# --------------------------------------------------------------------------- #

@app.get("/health", tags=["health"])
async def health() -> dict[str, Any]:
    cfg = get_settings()
    return {
        "status": "ok",
        "service": SERVICE,
        "bridge": "ready",
        "version": VERSION,
        "gateway": cfg.gateway_url,
        "r2Configured": cfg.r2_configured(),
    }


def _clean_original_name(filename: str) -> str:
    """Keeps multipart filenames inside the gateway's 180-character bound while preserving .pdf."""
    name = (filename or "").replace("\x00", "").strip()
    if len(name) <= 180:
        return name
    return (name[:176] + ".pdf") if name.lower().endswith(".pdf") else name[:180]


def _parse_tags(raw: str | None) -> list[str]:
    if raw is None:
        return []
    text = raw.strip()
    if not text:
        return []
    if text.startswith("["):
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                return [str(item) for item in parsed]
        except ValueError:
            pass
    return [part for part in text.split(",") if part.strip()][:20]


@app.post("/api/v1/storage/upload", tags=["bridge"])
async def upload_pdf(
    request: Request,
    file: UploadFile = File(..., description="The PDF file to store (multipart form field `file`)."),
    title: str | None = Form(default=None, description="Optional human-readable title."),
    description: str | None = Form(default=None),
    category: str | None = Form(default=None),
    tags: str | None = Form(default=None, description="Optional comma-separated or JSON-array tags."),
    _custom_key: str = Depends(require_custom_api_key),
) -> JSONResponse:
    request_id = request.state.request_id
    cfg = get_settings()

    filename = _clean_original_name(file.filename or "")
    declared_length = request.headers.get("content-length")
    declared_bytes = int(declared_length) if declared_length and declared_length.isdigit() else None
    assert_pdf_metadata(filename, file.content_type, declared_bytes, cfg.max_pdf_bytes)

    size = validate_and_sniff_pdf(filename, file.content_type, file.file, cfg.max_pdf_bytes)

    object_key = build_object_key()
    try:
        await upload_pdf_object(object_key, file.file, size)
    except HTTPException:
        await delete_object(object_key)
        raise
    finally:
        file.file.close()

    # Sign the URL first so a registration failure can clean up the object.
    try:
        url = await presigned_get_url(object_key, filename, cfg.signed_url_expiry_seconds)
    except HTTPException:
        await delete_object(object_key)
        raise
    try:
        file_data = await register_file_with_gateway(
            {
                "storageKey": object_key,
                "originalName": filename,
                "title": (title or "").strip()[:160] or filename.rsplit(".", 1)[0],
                "description": (description or "").strip()[:2000],
                "category": (category or "").strip()[:80],
                "tags": _parse_tags(tags),
                "size": size,
            },
            request_id,
        )
    except (GatewayUnavailable, GatewayRejected) as registration_error:
        # Compensation: never leave an unregistered object behind.
        await delete_object(object_key)
        if isinstance(registration_error, GatewayRejected) and registration_error.status < 500:
            return fail(
                registration_error.code,
                registration_error.message,
                request_id,
                registration_error.status,
            )
        return fail(
            "GATEWAY_UNAVAILABLE",
            "The document could not be registered with the AM Storage gateway. Please retry shortly.",
            request_id,
            503,
        )

    expires_at = time.time() + cfg.signed_url_expiry_seconds
    return ok(
        {
            "file": file_data,
            "url": url,
            "expiresAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(expires_at)),
            "filename": filename,
            "size": size,
        },
        request_id,
        201,
    )


@app.get("/api/files", tags=["bridge"])
async def list_files(request: Request, _custom_key: str = Depends(require_custom_api_key)) -> Response:
    """Lists active PDF metadata for gramunnayan.com (read-only, key protected)."""
    return await gateway_get("/api/files", request)


@app.get("/api/files/{file_id}/download", tags=["bridge"])
async def download_file(request: Request, file_id: str, _custom_key: str = Depends(require_custom_api_key)) -> Response:
    """Returns a 302 to a signed PDF URL (or the signed URL JSON) for a document."""
    return await gateway_get(f"/api/files/{file_id}/download", request)


@app.get("/api/files/{file_id}", tags=["bridge"])
async def file_detail(request: Request, file_id: str, _custom_key: str = Depends(require_custom_api_key)) -> Response:
    """Returns metadata for a single active PDF."""
    return await gateway_get(f"/api/files/{file_id}", request)
