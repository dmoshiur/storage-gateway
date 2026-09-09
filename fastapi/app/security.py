"""Credential validation, per-client throttling, and request identity.

gramunnayan.com authenticates with the dual-token pair issued by the dashboard:

- dual_token : X-AM-Storage-Key-Id + X-AM-Storage-Key-Secret
- signature  : X-AM-Storage-Key-Id + X-AM-Storage-Signature
               (HMAC-SHA256 of ``<timestamp>:<sha256hex(body)>``)
               + X-AM-Storage-Timestamp
- legacy     : a single X-AM-Storage-Key (pre-upgrade keys, still supported)

The raw values are forwarded to the AM Storage gateway registry (Firestore)
for verification — this process never holds Firebase or raw key material.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import time
import uuid
from collections import defaultdict, deque
from dataclasses import dataclass

from fastapi import HTTPException, Request

from .config import get_settings
from .gateway import GatewayRejected, GatewayUnavailable, verify_api_credential_with_gateway

UNAUTHORIZED = {
    "code": "INVALID_API_KEY",
    "message": "Missing or invalid API credential. Send X-AM-Storage-Key-Id with X-AM-Storage-Key-Secret (dual-token) or with X-AM-Storage-Signature and X-AM-Storage-Timestamp (HMAC signed).",
}


@dataclass(frozen=True)
class ApiCredential:
    """Resolved request credential used by endpoints and upload logging."""

    mode: str  # "legacy" | "dual_token" | "signature" | "static"
    key_id: str | None
    legacy_key: str | None = None

    @property
    def log_key(self) -> str:
        """Identifier recorded in upload logs (never a raw key or secret)."""
        if self.key_id:
            return self.key_id
        if self.legacy_key:
            return f"{self.legacy_key[:16]}…"
        return "unknown"


def request_id_from(request: Request) -> str:
    """Reuses an inbound request id when present (observability chains), else generates one."""
    supplied = (request.headers.get("x-request-id") or "").strip()
    if supplied and len(supplied) <= 96:
        return supplied
    return uuid.uuid4().hex


def client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip() or "unknown"
    return request.client.host if request.client else "unknown"


def _rate_limited(limit: int, window_seconds: int = 60) -> HTTPException:
    return HTTPException(
        status_code=429,
        detail={
            "code": "RATE_LIMITED",
            "message": "Too many requests. Please wait a moment and try again.",
        },
    )


class _RateLimiter:
    """Best-effort in-memory sliding-window limiter.

    It intentionally requires no extra infrastructure and is shared across the
    (single) bridge process. Pair it with a platform WAF in production for
    globally coordinated protection.
    """

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._buckets: dict[str, deque[float]] = defaultdict(deque)

    async def check(self, key: str, limit: int, window_seconds: int = 60) -> None:
        now = time.monotonic()
        async with self._lock:
            window = self._buckets[key]
            while window and window[0] <= now - window_seconds:
                window.popleft()
            if len(window) >= limit:
                raise _rate_limited(limit, window_seconds)
            window.append(now)
            # Bound memory under a spray of unique keys.
            if len(self._buckets) > 10_000:
                stale = [k for k, v in self._buckets.items() if not v or v[-1] <= now - window_seconds]
                for k in stale:
                    del self._buckets[k]


_rate_limiter = _RateLimiter()


async def enforce_bridge_rate_limit(request: Request, limit: int = 240, window_seconds: int = 60) -> None:
    await _rate_limiter.check(f"bridge:{client_ip(request)}", limit, window_seconds)


def _matches_static_key(supplied: str, static_keys: frozenset) -> bool:
    """Constant-time comparison across every configured static key."""
    supplied_bytes = supplied.encode("utf-8")
    matched = False
    for candidate in static_keys:
        candidate_bytes = candidate.encode("utf-8")
        matched = hmac.compare_digest(candidate_bytes, supplied_bytes) or matched
    return matched


def _gateway_unavailable() -> HTTPException:
    return HTTPException(
        status_code=503,
        detail={
            "code": "KEY_SERVICE_UNAVAILABLE",
            "message": "The key registry is temporarily unavailable. Please retry shortly.",
        },
    )


def parse_upload_credentials(request: Request) -> ApiCredential | None:
    """Extracts a consistent credential from the request headers.

    Returns None when no recognized credential is present (the caller raises
    401). Priority: legacy single key > dual-token pair > HMAC signature.
    """
    legacy = (request.headers.get("X-AM-Storage-Key") or "").strip()
    key_id = (request.headers.get("X-AM-Storage-Key-Id") or "").strip()
    secret = (request.headers.get("X-AM-Storage-Key-Secret") or "").strip()
    signature = (request.headers.get("X-AM-Storage-Signature") or "").strip()
    timestamp_raw = (request.headers.get("X-AM-Storage-Timestamp") or "").strip()

    if legacy:
        return ApiCredential(mode="legacy", key_id=None, legacy_key=legacy)
    if key_id and secret:
        return ApiCredential(mode="dual_token", key_id=key_id)
    if key_id and signature and timestamp_raw:
        return ApiCredential(mode="signature", key_id=key_id)
    return None


async def _verify_via_gateway(credential: ApiCredential, request: Request) -> dict[str, str]:
    """Builds the registry payload for the resolved credential and verifies it."""
    request_id = request_id_from(request)
    if credential.mode == "legacy":
        payload: dict[str, object] = {"key": credential.legacy_key or ""}
    elif credential.mode == "dual_token":
        payload = {
            "mode": "dual_token",
            "keyId": credential.key_id or "",
            "secret": (request.headers.get("X-AM-Storage-Key-Secret") or "").strip(),
        }
    else:  # signature
        # The signature covers the raw body bytes, so hash the exact body.
        body = await request.body()  # cached by Starlette; form parsing reuses it
        body_hash = hashlib.sha256(body).hexdigest()
        try:
            timestamp = int(request.headers.get("X-AM-Storage-Timestamp") or "")
        except ValueError as error:
            raise HTTPException(status_code=401, detail=UNAUTHORIZED) from error
        payload = {
            "mode": "signature",
            "keyId": credential.key_id or "",
            "timestamp": timestamp,
            "signature": (request.headers.get("X-AM-Storage-Signature") or "").strip().lower(),
            "bodyHash": body_hash,
        }
    try:
        return await verify_api_credential_with_gateway(payload, request_id)
    except (GatewayUnavailable, GatewayRejected) as error:
        # A reachable gateway only answers 2xx (with valid:false) for unknown
        # or revoked credentials, so any transport/upstream failure means the
        # registry is temporarily unavailable — never treat it as rejection.
        raise _gateway_unavailable() from error


async def require_api_credential(request: Request) -> ApiCredential:
    """FastAPI dependency: validates the API credential and tracks usage.

    Resolution order:
      1. Static keys (AM_STORAGE_KEYS) are accepted locally without a network
         call — legacy header, or a dual-token secret that matches a static key.
      2. Otherwise the credential is verified against the AM Storage gateway
         registry (Firestore), which is where dashboard-generated
         `am_store_live_*` credentials live. Verification refreshes
         `lastUsedAt` and records the request hit shown on the dashboard.

    Raises 401/429/503 HTTP errors with the API envelope shape.
    """
    credential = parse_upload_credentials(request)
    if credential is None:
        raise HTTPException(status_code=401, detail=UNAUTHORIZED)

    await enforce_bridge_rate_limit(request)

    settings = get_settings()
    if settings.static_keys:
        if credential.mode == "legacy" and _matches_static_key(credential.legacy_key or "", settings.static_keys):
            return ApiCredential(mode="static", key_id=None, legacy_key=credential.legacy_key)
        if credential.mode == "dual_token":
            secret = (request.headers.get("X-AM-Storage-Key-Secret") or "").strip()
            if _matches_static_key(secret, settings.static_keys):
                return ApiCredential(mode="static", key_id=credential.key_id)

    verified = await _verify_via_gateway(credential, request)
    if not verified.get("valid"):
        raise HTTPException(status_code=401, detail=UNAUTHORIZED)
    return credential


def masked_key(key: str) -> str:
    """Short, log-safe preview of a key (am_store_live_…xxxx)."""
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:8]
    return f"am_store_live_…{digest}"
