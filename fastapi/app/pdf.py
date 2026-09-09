"""Structural PDF validation for the bridge.

These checks are a strict, inexpensive gate (extension, declared content type,
size bounds, %PDF header, and %%EOF trailer) — they are not an antivirus or
malware scanner. They mirror the server-side checks the AM Storage gateway
applies to administrative uploads.
"""
from __future__ import annotations

import re
from typing import BinaryIO

from fastapi import HTTPException

PDF_HEADER_RE = re.compile(rb"^%PDF-1\.[0-7]")
_EOF_TAIL = b"%%EOF"
_HEADER_BYTES = 2048
_MAX_SIZE_BYTES_SENTINEL = 1024 * 1024 * 1024  # sanity bound independent of the configured limit


def error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


def has_pdf_extension(filename: str) -> bool:
    return filename.lower().endswith(".pdf")


def assert_pdf_metadata(filename: str, content_type: str | None, declared_bytes: int | None, max_bytes: int) -> None:
    if not has_pdf_extension(filename or ""):
        raise error(415, "INVALID_FILE_TYPE", "Only PDF files are accepted.")
    if (content_type or "").lower().split(";")[0] != "application/pdf":
        raise error(415, "INVALID_FILE_TYPE", "Only PDF files (application/pdf) are accepted.")
    if declared_bytes is not None and declared_bytes > max_bytes:
        raise error(413, "FILE_TOO_LARGE", f"PDFs larger than {max_bytes} bytes are not accepted.")


def inspect_pdf_signature(head: bytes, tail: bytes) -> None:
    if not PDF_HEADER_RE.match(head[: _HEADER_BYTES]):
        raise error(400, "INVALID_PDF", "The uploaded file does not have a valid PDF header.")
    stripped_tail = tail.rstrip(b"\x00\t\n\r\f ")
    if not stripped_tail.endswith(_EOF_TAIL):
        raise error(400, "INVALID_PDF", "The uploaded file is missing a valid PDF end marker.")


def validate_and_sniff_pdf(filename: str, content_type: str | None, stream: BinaryIO, max_bytes: int) -> int:
    """Validates a spooled upload and returns its byte size.

    The caller must seek the stream back to zero before uploading to R2.
    """
    stream.seek(0, 2)
    size = stream.tell()
    stream.seek(0)

    if not isinstance(size, int) or size <= 0:
        raise error(400, "INVALID_FILE_SIZE", "The uploaded PDF is empty or unreadable.")
    if size > max_bytes or size > _MAX_SIZE_BYTES_SENTINEL:
        raise error(413, "FILE_TOO_LARGE", f"PDFs larger than {max_bytes} bytes are not accepted.")

    head = stream.read(_HEADER_BYTES)
    tail_size = min(size, _HEADER_BYTES)
    stream.seek(-tail_size, 2)
    tail = stream.read(tail_size)
    stream.seek(0)

    inspect_pdf_signature(head, tail)
    return size
