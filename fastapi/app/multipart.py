"""Multipart form parsing for the bridge upload endpoint.

The upload route parses the request body itself (instead of using FastAPI
File/Form parameters) so that the credential dependency can read the raw body
first — HMAC signature mode needs the exact bytes before any parsing happens,
and Starlette's form parser consumes the raw stream without caching
``request._body``.
"""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from starlette.datastructures import FormData, Headers
from starlette.formparsers import MultiPartException, MultiPartParser


def invalid(message: str, code: str = "VALIDATION_ERROR", status_code: int = 400) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


async def parse_multipart_form(request: Any, max_part_bytes: int) -> FormData:
    """Parses the buffered request body as multipart/form-data."""
    content_type = (request.headers.get("content-type") or "").lower()
    if "multipart/form-data" not in content_type:
        raise invalid("The upload must be sent as multipart/form-data.")

    body = await request.body()
    if not body:
        raise invalid("The request body is empty.")

    async def body_stream():
        yield body
        yield b""

    try:
        parser = MultiPartParser(
            Headers(scope=request.scope),
            body_stream(),
            max_files=1,
            max_fields=16,
            max_part_size=max_part_bytes,
        )
        return await parser.parse()
    except MultiPartException as error:
        raise invalid(str(getattr(error, "message", error)))
