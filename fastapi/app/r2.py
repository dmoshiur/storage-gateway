"""Cloudflare R2 object operations for the bridge.

The bridge is the only component besides the gateway that holds R2 credentials;
gramunnayan.com only ever receives the short-lived signed URLs this module
creates.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, BinaryIO

from fastapi import HTTPException

from .config import get_settings


def unavailable(code: str = "STORAGE_UNAVAILABLE", message: str = "R2 storage is not configured.") -> HTTPException:
    return HTTPException(status_code=503, detail={"code": code, "message": message})


def _r2_environment() -> dict[str, str]:
    settings = get_settings()
    if not settings.r2_configured():
        raise unavailable()
    return {
        "endpoint_url": settings.r2_endpoint,
        "bucket": settings.r2_bucket_name,
        "aws_access_key_id": settings.r2_access_key_id,
        "aws_secret_access_key": settings.r2_secret_access_key,
    }


def build_object_key() -> str:
    """Random final object key following the gateway's pdfs/YYYY/MM/<uuid>.pdf layout."""
    now = datetime.now(timezone.utc)
    return f"pdfs/{now.year}/{now.month:02d}/{uuid.uuid4()}.pdf"


def _client(environment: dict[str, str], s3_session: Any) -> Any:
    return s3_session.client(
        "s3",
        endpoint_url=environment["endpoint_url"],
        aws_access_key_id=environment["aws_access_key_id"],
        aws_secret_access_key=environment["aws_secret_access_key"],
        region_name="auto",
    )


async def upload_pdf_object(key: str, source: BinaryIO, expected_size: int) -> str:
    """Streams a validated PDF into R2 and verifies the stored object.

    Returns the object ETag. Raises 502 HTTP errors with the API envelope shape
    when the upload or the post-upload HEAD verification fails.
    """
    environment = _r2_environment()
    import aioboto3

    session = aioboto3.Session()
    try:
        async with _client(environment, session) as s3:
            await s3.upload_fileobj(
                source,
                environment["bucket"],
                key,
                ExtraArgs={"ContentType": "application/pdf"},
            )
            head = await s3.head_object(Bucket=environment["bucket"], Key=key)
    except Exception as upload_error:
        raise HTTPException(
            status_code=502,
            detail={"code": "R2_UPLOAD_FAILED", "message": "The PDF could not be stored. Please retry shortly."},
        ) from upload_error

    stored_size = int(head.get("ContentLength", -1))
    if stored_size != expected_size:
        await delete_object(key)
        raise HTTPException(
            status_code=502,
            detail={"code": "R2_UPLOAD_FAILED", "message": "The stored PDF could not be verified."},
        )
    return str(head.get("ETag", ""))


async def delete_object(key: str) -> None:
    """Best-effort delete used to clean up partial objects after failures.

    Never raises: compensation cleanup must not mask the original error, and
    unconfigured R2 (or a transient outage) simply leaves an orphan for a later
    sweep.
    """
    try:
        environment = _r2_environment()
        import aioboto3

        session = aioboto3.Session()
        async with _client(environment, session) as s3:
            await s3.delete_object(Bucket=environment["bucket"], Key=key)
    except Exception:
        pass


async def presigned_get_url(key: str, filename: str, expires_in_seconds: int) -> str:
    environment = _r2_environment()
    import aioboto3

    session = aioboto3.Session()
    try:
        async with _client(environment, session) as s3:
            return await s3.generate_presigned_url(
                "get_object",
                Params={
                    "Bucket": environment["bucket"],
                    "Key": key,
                    "ResponseContentType": "application/pdf",
                    "ResponseContentDisposition": f"inline; filename=\"{filename.replace(chr(34), '').replace(chr(10), '').replace(chr(13), '')}\"",
                },
                ExpiresIn=expires_in_seconds,
            )
    except Exception as signing_error:
        raise HTTPException(
            status_code=502,
            detail={"code": "STORAGE_UNAVAILABLE", "message": "A signed PDF URL could not be generated. Please retry shortly."},
        ) from signing_error
