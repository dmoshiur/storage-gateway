"""Consistent JSON envelopes for the bridge, mirroring the AM Storage gateway API."""
from __future__ import annotations

from typing import Any

from fastapi.responses import JSONResponse


def envelope_payload(data: Any, request_id: str) -> dict[str, Any]:
    return {"success": True, "data": data, "requestId": request_id}


def error_payload(code: str, message: str, request_id: str) -> dict[str, Any]:
    return {"success": False, "error": {"code": code, "message": message}, "requestId": request_id}


def ok(data: Any, request_id: str, status_code: int = 200) -> JSONResponse:
    return JSONResponse(content=envelope_payload(data, request_id), status_code=status_code)


def fail(code: str, message: str, request_id: str, status_code: int) -> JSONResponse:
    return JSONResponse(content=error_payload(code, message, request_id), status_code=status_code)
