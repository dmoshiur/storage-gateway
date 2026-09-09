"""Server-to-server client for the AM Storage gateway (Next.js control plane).

Every call is authenticated with the shared INTEGRATION_API_KEY header. The
bridge forwards the raw Custom API Key value it received from gramunnayan.com
so the gateway (the single source of truth, backed by Firestore) can verify the
key hash, enforce revocation, and refresh lastUsedAt. Raw R2/Firestore secrets
never leave the gateway.
"""
from __future__ import annotations

from typing import Any

import httpx

from .config import get_settings

TIMEOUT = httpx.Timeout(12.0, connect=5.0)


class GatewayUnavailable(Exception):
    """The gateway could not be reached (network/transport failure)."""


class GatewayRejected(Exception):
    """The gateway answered with a non-2xx response."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def _headers(request_id: str) -> dict[str, str]:
    settings = get_settings()
    if not settings.integration_key:
        raise GatewayUnavailable("INTEGRATION_API_KEY is not configured on the bridge")
    return {
        "X-Storage-Gateway-Key": settings.integration_key,
        "X-Request-Id": request_id,
        "Content-Type": "application/json",
    }


async def _post_json(path: str, payload: dict[str, Any], request_id: str) -> dict[str, Any]:
    settings = get_settings()
    url = f"{settings.gateway_url}{path}"
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            response = await client.post(url, json=payload, headers=_headers(request_id))
    except httpx.HTTPError as error:
        raise GatewayUnavailable("The AM Storage gateway is unreachable") from error

    body: Any = {}
    try:
        body = response.json()
    except ValueError:
        body = {}

    if response.status_code >= 400:
        error = body.get("error") or {} if isinstance(body, dict) else {}
        code = error.get("code") if isinstance(error, dict) else None
        message = error.get("message") if isinstance(error, dict) else None
        raise GatewayRejected(
            response.status_code,
            str(code or "GATEWAY_ERROR"),
            str(message or "The AM Storage gateway rejected the request."),
        )

    if not isinstance(body, dict) or not body.get("success"):
        raise GatewayRejected(502, "INVALID_GATEWAY_RESPONSE", "The AM Storage gateway returned an unexpected response.")
    return body.get("data") or {}


async def verify_custom_key_with_gateway(key: str, request_id: str) -> dict[str, Any]:
    """Validates a presented Custom API Key against the gateway registry.

    Returns {"valid": bool, "keyId": str | None}. Raises GatewayUnavailable or
    GatewayRejected on transport/upstream errors so callers can distinguish a
    revoked key (valid=False) from a broken key service.
    """
    return await _post_json(
        "/api/internal/bridge/verify-key",
        {"key": key},
        request_id,
    )


async def register_file_with_gateway(payload: dict[str, Any], request_id: str) -> dict[str, Any]:
    """Registers an R2-verified bridge upload in the gateway's metadata store.

    The payload must contain the final R2 object key, validated PDF metadata and
    size. Returns the serialized file record ({id, originalName, title, size,
    status: "active", ...}) on success.
    """
    return await _post_json("/api/internal/bridge/files", payload, request_id)


_HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}


async def gateway_get(path: str, request: Any) -> Any:
    """Forwards a read request to the gateway and relays its response verbatim.

    Used by the protected listing/detail/download endpoints. Query parameters
    are preserved so integrations can paginate and search exactly like the
    gateway API. Redirect responses (302 signed URL downloads) are relayed.
    """
    from fastapi import HTTPException
    from fastapi.responses import Response

    settings = get_settings()
    if not settings.integration_key:
        raise HTTPException(
            status_code=503,
            detail={"code": "GATEWAY_NOT_CONFIGURED", "message": "INTEGRATION_API_KEY is not configured on the bridge."},
        )
    request_id = getattr(request.state, "request_id", "")
    url = f"{settings.gateway_url}{path}"
    if request.url.query:
        url = f"{url}?{request.url.query}"
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            response = await client.get(url, headers=_headers(request_id), follow_redirects=False)
    except httpx.HTTPError as error:
        raise HTTPException(
            status_code=502,
            detail={"code": "GATEWAY_UNAVAILABLE", "message": "The AM Storage gateway is unreachable. Please retry shortly."},
        ) from error

    relayed_headers = {
        key: value
        for key, value in response.headers.items()
        if key.lower() not in _HOP_BY_HOP_HEADERS
    }
    return Response(
        content=response.content,
        status_code=response.status_code,
        headers=relayed_headers,
    )
