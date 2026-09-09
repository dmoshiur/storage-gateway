"""Key validation, per-client throttling, and request identity for the bridge."""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import time
import uuid
from collections import defaultdict, deque

from fastapi import HTTPException, Request

from .config import get_settings
from .gateway import GatewayRejected, GatewayUnavailable, verify_custom_key_with_gateway

UNAUTHORIZED = {"code": "INVALID_API_KEY", "message": "The X-AM-Storage-Key header is missing or invalid."}


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


async def require_custom_api_key(request: Request) -> str:
    """FastAPI dependency: validates X-AM-Storage-Key and tracks usage.

    Resolution order:
      1. A key listed in AM_STORAGE_KEYS (self-hosted static mode) is accepted
         locally without a network call.
      2. Otherwise the key is verified against the AM Storage gateway registry
         (Firestore), which is where dashboard-generated `am_store_live_*` keys
         live. Verification refreshes the key's lastUsedAt timestamp.

    Raises 401/429/503 HTTP errors with the API envelope shape.
    """
    supplied = (request.headers.get("X-AM-Storage-Key") or "").strip()
    if not supplied:
        raise HTTPException(status_code=401, detail=UNAUTHORIZED)

    await enforce_bridge_rate_limit(request)

    settings = get_settings()
    if settings.static_keys and _matches_static_key(supplied, settings.static_keys):
        return supplied

    try:
        verified = await verify_custom_key_with_gateway(supplied, request_id_from(request))
    except (GatewayUnavailable, GatewayRejected) as error:
        # A reachable gateway only answers 2xx (with valid:false) for unknown or
        # revoked keys, so any transport/upstream failure means the registry is
        # temporarily unavailable — never treat it as a definitive rejection.
        raise HTTPException(
            status_code=503,
            detail={
                "code": "KEY_SERVICE_UNAVAILABLE",
                "message": "The key registry is temporarily unavailable. Please retry shortly.",
            },
        ) from error

    if not verified.get("valid"):
        raise HTTPException(status_code=401, detail=UNAUTHORIZED)
    return supplied


def masked_key(key: str) -> str:
    """Short, log-safe preview of a key (am_store_live_…xxxx)."""
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:8]
    return f"am_store_live_…{digest}"
