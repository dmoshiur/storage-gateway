"""Runtime configuration for the AM Storage Bridge.

Credentials are read from the process environment on every request so that
rotated secrets (for example after a deploy) are picked up without a restart.
This keeps the bridge free of client-side R2/Firebase secrets by design.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field

# gramunnayan.com is the only origin that should call the bridge from a browser.
DEFAULT_CORS_ORIGINS = "https://gramunnayan.com,https://www.gramunnayan.com"

DEFAULT_MAX_PDF_BYTES = 50 * 1024 * 1024  # mirrors the gateway's default settings.maxPdfSizeBytes
DEFAULT_SIGNED_URL_EXPIRY_SECONDS = 3600


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    service_name: str = "AM Storage Company"
    gateway_url: str = "http://localhost:3000"
    # Server-to-server secret shared with the AM Storage gateway (Next.js). The
    # bridge presents it when verifying Custom API Keys and registering files.
    integration_key: str = ""
    # Optional comma-separated static keys accepted without a gateway call.
    # Useful for self-hosted/offline deployments; dashboard-managed keys are
    # always verified against the gateway registry.
    static_keys: frozenset = field(default_factory=frozenset)
    max_pdf_bytes: int = DEFAULT_MAX_PDF_BYTES
    signed_url_expiry_seconds: int = DEFAULT_SIGNED_URL_EXPIRY_SECONDS
    cors_origins: tuple = ()

    @property
    def r2_endpoint(self) -> str:
        return os.getenv("R2_ENDPOINT", "").strip()

    @property
    def r2_account_id(self) -> str:
        return os.getenv("R2_ACCOUNT_ID", "").strip()

    @property
    def r2_access_key_id(self) -> str:
        return os.getenv("R2_ACCESS_KEY_ID", "").strip()

    @property
    def r2_secret_access_key(self) -> str:
        return os.getenv("R2_SECRET_ACCESS_KEY", "").strip()

    @property
    def r2_bucket_name(self) -> str:
        return os.getenv("R2_BUCKET_NAME", "").strip()

    def r2_configured(self) -> bool:
        return bool(
            self.r2_endpoint
            and self.r2_access_key_id
            and self.r2_secret_access_key
            and self.r2_bucket_name
        )


def get_settings() -> Settings:
    gateway_url = os.getenv("STORAGE_GATEWAY_URL", "http://localhost:3000").strip().rstrip("/")
    static_keys = frozenset(
        key.strip()
        for key in os.getenv("AM_STORAGE_KEYS", "").split(",")
        if key.strip()
    )
    origins = tuple(
        origin.strip()
        for origin in os.getenv("CORS_ORIGINS", DEFAULT_CORS_ORIGINS).split(",")
        if origin.strip()
    )
    return Settings(
        gateway_url=gateway_url,
        integration_key=os.getenv("INTEGRATION_API_KEY", "").strip(),
        static_keys=static_keys,
        # AM_STORAGE_MAX_DOCUMENT_BYTES is preferred; AM_STORAGE_MAX_PDF_BYTES
        # remains accepted for existing deployments.
        max_pdf_bytes=_env_int(
            "AM_STORAGE_MAX_DOCUMENT_BYTES",
            _env_int("AM_STORAGE_MAX_PDF_BYTES", DEFAULT_MAX_PDF_BYTES),
        ),
        signed_url_expiry_seconds=_env_int(
            "AM_STORAGE_SIGNED_URL_EXPIRY_SECONDS", DEFAULT_SIGNED_URL_EXPIRY_SECONDS
        ),
        cors_origins=origins,
    )
