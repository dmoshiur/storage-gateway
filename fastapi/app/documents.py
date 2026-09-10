"""Structural document validation for the AM Storage bridge.

Supported types: PDF, DOC, DOCX, TXT, PPT, PPTX.

These checks are a strict, inexpensive gate (extension, declared content type,
size bounds, and a light magic-byte sniff) — they are not an antivirus or
malware scanner. They mirror the server-side checks the AM Storage gateway
applies to administrator-uploaded documents.
"""
from __future__ import annotations

import re
from typing import BinaryIO

from fastapi import HTTPException

PDF_HEADER_RE = re.compile(rb"^%PDF-1\.[0-7]")
_EOF_TAIL = b"%%EOF"
_OLE2_MAGIC = bytes([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])
_ZIP_MAGIC = b"PK\x03\x04"
_HEADER_BYTES = 2048
_MAX_SIZE_BYTES_SENTINEL = 1024 * 1024 * 1024  # sanity bound independent of the configured limit

SUPPORTED_EXTENSIONS = {"pdf", "doc", "docx", "txt", "ppt", "pptx"}

MIME_BY_EXTENSION = {
    "pdf": "application/pdf",
    "doc": "application/msword",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "txt": "text/plain",
    "ppt": "application/vnd.ms-powerpoint",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}

EXTENSION_BY_MIME = {value: key for key, value in MIME_BY_EXTENSION.items()}


def error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


def get_extension(filename: str) -> str | None:
    match = re.search(r"\.([A-Za-z0-9]+)$", (filename or "").strip())
    extension = match.group(1).lower() if match else None
    return extension if extension in SUPPORTED_EXTENSIONS else None


def resolve_mime_type(extension: str, content_type: str | None) -> str:
    normalized = (content_type or "").lower().split(";")[0].strip()
    if normalized and normalized in EXTENSION_BY_MIME:
        return normalized
    return MIME_BY_EXTENSION[extension]


def assert_document_metadata(filename: str, content_type: str | None, declared_bytes: int | None, max_bytes: int) -> tuple[str, str]:
    """Validates extension/declared MIME/size and returns (extension, mime_type)."""
    extension = get_extension(filename or "")
    if extension is None:
        raise error(415, "INVALID_FILE_TYPE", "Only PDF, DOC, DOCX, TXT, PPT, and PPTX documents are accepted.")
    mime_type = resolve_mime_type(extension, content_type)
    if content_type:
        normalized = (content_type or "").lower().split(";")[0].strip()
        if normalized not in {"application/octet-stream", *MIME_BY_EXTENSION.values()}:
            raise error(415, "INVALID_FILE_TYPE", "The submitted content type is not a supported document type.")
        known_extension = EXTENSION_BY_MIME.get(normalized)
        if known_extension and known_extension != extension:
            raise error(415, "INVALID_FILE_TYPE", "The document content type does not match its file extension.")
    if declared_bytes is not None and declared_bytes > max_bytes:
        raise error(413, "FILE_TOO_LARGE", f"Documents larger than {max_bytes} bytes are not accepted.")
    return extension, mime_type


def sniff_document(extension: str, head: bytes, tail: bytes) -> None:
    if extension == "pdf":
        if not PDF_HEADER_RE.match(head[:_HEADER_BYTES]):
            raise error(400, "INVALID_DOCUMENT", "The uploaded file does not have a valid PDF header.")
        stripped_tail = tail.rstrip(b"\x00\t\n\r\f ")
        if not stripped_tail.endswith(_EOF_TAIL):
            raise error(400, "INVALID_DOCUMENT", "The uploaded file is missing a valid PDF end marker.")
        return
    if extension in {"doc", "ppt"}:
        if not head.startswith(_OLE2_MAGIC):
            raise error(400, "INVALID_DOCUMENT", "The uploaded file does not have a valid legacy Office signature.")
        return
    if extension in {"docx", "pptx"}:
        if not head.startswith(_ZIP_MAGIC):
            raise error(400, "INVALID_DOCUMENT", "The uploaded file does not have a valid Office Open XML signature.")
        return
    # Plain text is intentionally accepted on extension/MIME only.


def validate_and_sniff_document(filename: str, content_type: str | None, stream: BinaryIO, max_bytes: int) -> tuple[int, str, str]:
    """Validates a spooled upload and returns (size, extension, mime_type).

    The caller must seek the stream back to zero before uploading to R2.
    """
    stream.seek(0, 2)
    size = stream.tell()
    stream.seek(0)

    if not isinstance(size, int) or size <= 0:
        raise error(400, "INVALID_FILE_SIZE", "The uploaded document is empty or unreadable.")
    if size > max_bytes or size > _MAX_SIZE_BYTES_SENTINEL:
        raise error(413, "FILE_TOO_LARGE", f"Documents larger than {max_bytes} bytes are not accepted.")

    extension, mime_type = assert_document_metadata(filename, content_type, size, max_bytes)

    head = stream.read(_HEADER_BYTES)
    tail_size = min(size, _HEADER_BYTES)
    stream.seek(-tail_size, 2)
    tail = stream.read(tail_size)
    stream.seek(0)

    sniff_document(extension, head, tail)
    return size, extension, mime_type
