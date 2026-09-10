"""Backward-compatible PDF-only import helpers for old bridge code.

The bridge now accepts PDF, DOC, DOCX, TXT, PPT, and PPTX documents. New code
should import from `.documents`; this module keeps legacy imports working.
"""
from __future__ import annotations

from fastapi import HTTPException

from .documents import assert_document_metadata, get_extension, sniff_document, validate_and_sniff_document


def error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


def has_pdf_extension(filename: str) -> bool:
    return get_extension(filename or "") == "pdf"


def assert_pdf_metadata(filename: str, content_type: str | None, declared_bytes: int | None, max_bytes: int) -> None:
    extension, _ = assert_document_metadata(filename, content_type, declared_bytes, max_bytes)
    if extension != "pdf":
        raise error(415, "INVALID_FILE_TYPE", "Only PDF files are accepted.")


def inspect_pdf_signature(head: bytes, tail: bytes) -> None:
    sniff_document("pdf", head, tail)


def validate_and_sniff_pdf(filename: str, content_type: str | None, stream, max_bytes: int) -> int:
    size, extension, _ = validate_and_sniff_document(filename, content_type, stream, max_bytes)
    if extension != "pdf":
        raise error(415, "INVALID_FILE_TYPE", "Only PDF files are accepted.")
    return size
