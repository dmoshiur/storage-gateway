"""AM Storage Company Storage Bridge — FastAPI application.

gramunnayan.com talks only to this public API. The bridge:

1. validates the dashboard-managed dual-token API credential
   (X-AM-Storage-Key-Id + X-AM-Storage-Key-Secret, or an HMAC signature,
   or a legacy X-AM-Storage-Key),
2. streams multipart PDF, DOC, DOCX, TXT, PPT, and PPTX uploads into private
   Cloudflare R2,
3. registers the verified document with the AM Storage gateway (metadata,
   retention, audit), and
4. returns a signed, expiring document URL — the only R2 artifact the client sees.

Every upload attempt (success or failure) is logged to the gateway so the
dashboard's "API Upload Activity" widget stays live. R2 and gateway secrets
live exclusively in this process; they are never shared with the client
website or its visitors.
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any
from urllib.parse import quote

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from starlette.datastructures import UploadFile

from .config import get_settings
from .gateway import GatewayRejected, GatewayUnavailable, gateway_get, log_upload_with_gateway, register_file_with_gateway
from .documents import get_extension, validate_and_sniff_document
from .multipart import parse_multipart_form
from .responses import fail, ok
from .r2 import build_object_key, delete_object, presigned_get_url, upload_document_object
from .security import ApiCredential, client_ip, request_id_from, require_api_credential

logger = logging.getLogger("am-storage-bridge")

VERSION = "3.1.0"
SERVICE = "AM Storage Company"
BRIDGE = "AM Storage Bridge"
UPLOAD_PATH = "/api/v1/storage/upload"

app = FastAPI(
    title=f"{BRIDGE} API",
    description="Public document Storage Bridge for gramunnayan.com (PDF, DOC, DOCX, TXT, PPT, PPTX). Authenticate with the "
    "dual-token pair generated in the AM Storage Company dashboard — "
    "X-AM-Storage-Key-Id + X-AM-Storage-Key-Secret, or the HMAC signed mode "
    "(X-AM-Storage-Signature + X-AM-Storage-Timestamp). R2 credentials are never "
    "exposed to client sites.",
    version=VERSION,
)

_settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(_settings.cors_origins),
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=[
        "X-AM-Storage-Key",
        "X-AM-Storage-Key-Id",
        "X-AM-Storage-Key-Secret",
        "X-AM-Storage-Signature",
        "X-AM-Storage-Timestamp",
        "Content-Type",
        "X-Request-Id",
    ],
)


# --------------------------------------------------------------------------- #
# Error envelope + access logging
# --------------------------------------------------------------------------- #

def _failure_code(exc: HTTPException) -> str:
    detail = exc.detail if isinstance(exc.detail, dict) else {}
    return str(detail.get("code", "REQUEST_FAILED"))


def _upload_log_payload(
    credential: ApiCredential | None,
    filename: str,
    size_bytes: int,
    code: str | None,
    request_id: str,
) -> dict[str, Any]:
    """One entry for the gateway's apiUploadLogs collection (matches its schema)."""
    return {
        "keyId": credential.log_key if credential else "rejected",
        "filename": filename,
        "sizeBytes": size_bytes,
        "status": "success" if code is None else "failed",
        "failureCode": code,
        "requestId": request_id,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
    }


async def _record_upload_failure(request: Request, status_code: int, code: str, request_id: str) -> None:
    """Best-effort: record a rejected upload attempt for the dashboard log."""
    if request.url.path != UPLOAD_PATH or status_code < 400:
        return
    filename = getattr(request.state, "upload_filename", None) or "unknown"
    key_id = (request.headers.get("X-AM-Storage-Key-Id") or "").strip()
    legacy_key = (request.headers.get("X-AM-Storage-Key") or "").strip()
    log_key = key_id or (f"{legacy_key[:16]}…" if legacy_key else "rejected")
    await log_upload_with_gateway(
        {**_upload_log_payload(None, filename, 0, code, request_id), "keyId": log_key},
        request_id,
    )


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    request_id = getattr(request.state, "request_id", request_id_from(request))
    detail = exc.detail if isinstance(exc.detail, dict) else {"code": "REQUEST_FAILED", "message": str(exc.detail or "Request failed.")}
    await _record_upload_failure(request, exc.status_code, _failure_code(exc), request_id)
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
    await _record_upload_failure(request, 422, "VALIDATION_ERROR", request_id)
    return fail("VALIDATION_ERROR", f"{location}: {message}", request_id, 422)


@app.middleware("http")
async def observe_requests(request: Request, call_next: Any) -> Response:
    request.state.request_id = request_id_from(request)
    started = time.perf_counter()

    response = await call_next(request)

    duration_ms = round((time.perf_counter() - started) * 1000, 1)
    supplied_key = request.headers.get("X-AM-Storage-Key-Id") or request.headers.get("X-AM-Storage-Key")
    logger.info(
        json.dumps({
            "event": "bridge_access",
            "requestId": request.state.request_id,
            "method": request.method,
            "path": request.url.path,
            "status": response.status_code,
            "durationMs": duration_ms,
            "ip": client_ip(request),
            "key": quote(supplied_key, safe="")[:64] if supplied_key else None,
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
        "auth": "dual-token|hmac|legacy",
        "gateway": cfg.gateway_url,
        "r2Configured": cfg.r2_configured(),
    }


def _clean_original_name(filename: str) -> str:
    """Keeps multipart filenames inside the gateway's 180-character bound while preserving a supported extension."""
    name = (filename or "").replace("\x00", "").strip()
    if len(name) <= 180:
        return name
    extension = get_extension(name)
    suffix = f".{extension}" if extension else ""
    return name[: max(0, 180 - len(suffix))] + suffix


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


@app.post(
    UPLOAD_PATH,
    tags=["bridge"],
    description=(
        "Store a document. Multipart form data with a `file` field for PDF, "
        "DOC, DOCX, TXT, PPT, or PPTX and optional fields `title`, "
        "`description`, `category`, `tags` (comma-separated or JSON array). "
        "Authenticate with the dual-token credential "
        "(X-AM-Storage-Key-Id + X-AM-Storage-Key-Secret) or the HMAC signed "
        "headers (X-AM-Storage-Signature + X-AM-Storage-Timestamp)."
    ),
)
async def upload_document(
    request: Request,
    credential: ApiCredential = Depends(require_api_credential),
) -> JSONResponse:
    """The unified gateway endpoint.

    The credential dependency runs first and (for signed requests) hashes the
    raw body before anything else touches the stream. The multipart body is
    then parsed from the buffered bytes — this ordering is what makes
    signature verification over the exact request bytes possible.
    """
    request_id = request.state.request_id
    cfg = get_settings()

    form = await parse_multipart_form(request, cfg.max_pdf_bytes)
    file: UploadFile | None = form.get("file")
    if file is None:
        raise HTTPException(
            status_code=422,
            detail={"code": "VALIDATION_ERROR", "message": "The multipart form is missing the required 'file' field."},
        )
    title = form.get("title")
    description = form.get("description")
    category = form.get("category")
    tags = form.get("tags")

    filename = _clean_original_name(file.filename or "")
    request.state.upload_filename = filename
    size, extension, mime_type = validate_and_sniff_document(
        filename,
        file.content_type,
        file.file,
        cfg.max_pdf_bytes,
    )

    object_key = build_object_key(extension)
    try:
        await upload_document_object(object_key, file.file, size, mime_type)
    except HTTPException:
        await delete_object(object_key)
        raise
    finally:
        file.file.close()

    # Sign the URL first so a registration failure can clean up the object.
    try:
        url = await presigned_get_url(object_key, filename, cfg.signed_url_expiry_seconds, mime_type)
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
                "mimeType": mime_type,
                "extension": extension,
                "size": size,
            },
            request_id,
        )
    except (GatewayUnavailable, GatewayRejected) as registration_error:
        # Compensation: never leave an unregistered object behind.
        await delete_object(object_key)
        if isinstance(registration_error, GatewayRejected) and registration_error.status < 500:
            failure_code = registration_error.code
            await log_upload_with_gateway(
                _upload_log_payload(credential, filename, 0, failure_code, request_id),
                request_id,
            )
            return fail(
                registration_error.code,
                registration_error.message,
                request_id,
                registration_error.status,
            )
        await log_upload_with_gateway(
            _upload_log_payload(credential, filename, 0, "GATEWAY_UNAVAILABLE", request_id),
            request_id,
        )
        return fail(
            "GATEWAY_UNAVAILABLE",
            "The document could not be registered with the AM Storage gateway. Please retry shortly.",
            request_id,
            503,
        )

    await log_upload_with_gateway(_upload_log_payload(credential, filename, size, None, request_id), request_id)

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
async def list_files(request: Request, _credential: ApiCredential = Depends(require_api_credential)) -> Response:
    """Lists active PDF metadata for gramunnayan.com (read-only, credential protected)."""
    return await gateway_get("/api/files", request)


@app.get("/api/files/{file_id}/download", tags=["bridge"])
async def download_file(
    request: Request,
    file_id: str,
    _credential: ApiCredential = Depends(require_api_credential),
) -> Response:
    """Returns a 302 to a signed PDF URL (or the signed URL JSON) for a document."""
    return await gateway_get(f"/api/files/{quote(file_id, safe='')}/download", request)


@app.get("/api/files/{file_id}", tags=["bridge"])
async def file_detail(
    request: Request,
    file_id: str,
    _credential: ApiCredential = Depends(require_api_credential),
) -> Response:
    """Returns metadata for a single active PDF."""
    return await gateway_get(f"/api/files/{quote(file_id, safe='')}", request)
