import { ApiError } from "@/lib/api/errors";

export const SUPPORTED_DOCUMENT_EXTENSIONS = ["pdf", "doc", "docx", "txt", "ppt", "pptx"] as const;
export type SupportedDocumentExtension = (typeof SUPPORTED_DOCUMENT_EXTENSIONS)[number];

export const DOCUMENT_MIME_BY_EXTENSION: Record<SupportedDocumentExtension, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export const DOCUMENT_EXTENSION_BY_MIME: Record<string, SupportedDocumentExtension> = {
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "text/plain": "txt",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

export const DOCUMENT_ACCEPT = ".pdf,.doc,.docx,.txt,.ppt,.pptx";

const PDF_HEADER = /^%PDF-1\.[0-7](?:[\s%]|$)/;
const OLE2_MAGIC = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

/**
 * Supported document types for the AM Storage gateway and bridge:
 * PDF, DOC, DOCX, TXT, PPT, and PPTX. These are strict, inexpensive
 * extension/MIME/signature gates, not antivirus or malware scanners.
 */
export function getDocumentExtension(name: string): SupportedDocumentExtension | null {
  const match = name.trim().match(/\.([A-Za-z0-9]+)$/);
  const extension = match?.[1]?.toLowerCase();
  if (!extension || !(SUPPORTED_DOCUMENT_EXTENSIONS as readonly string[]).includes(extension)) return null;
  return extension as SupportedDocumentExtension;
}

export function documentMimeTypeFor(extension: SupportedDocumentExtension, suppliedMimeType?: string): string {
  const normalized = (suppliedMimeType ?? "").trim().toLowerCase().split(";")[0];
  if (normalized) {
    const knownExtension = DOCUMENT_EXTENSION_BY_MIME[normalized];
    if (knownExtension === extension) return normalized;
  }
  return DOCUMENT_MIME_BY_EXTENSION[extension];
}

function stripPdfLikeSuffix(name: string): string {
  return name.replace(/\.[A-Za-z0-9]+$/, "");
}

export function startsWith(bytes: Uint8Array, magic: Uint8Array): boolean {
  if (bytes.length < magic.length) return false;
  for (let index = 0; index < magic.length; index += 1) {
    if (bytes[index] !== magic[index]) return false;
  }
  return true;
}

export function inspectDocumentSignature(extension: SupportedDocumentExtension, firstBytes: Uint8Array, lastBytes?: Uint8Array): { valid: boolean; reason?: string } {
  const head = new TextDecoder("latin1").decode(firstBytes.subarray(0, 64));
  if (extension === "pdf") {
    if (!PDF_HEADER.test(head)) return { valid: false, reason: "The file does not have a valid PDF header." };
    if (lastBytes) {
      const tail = new TextDecoder("latin1").decode(lastBytes).replace(/[\0\t\n\r\f ]+$/g, "");
      if (!tail.includes("%%EOF")) return { valid: false, reason: "The file is missing a valid PDF end marker." };
    }
    return { valid: true };
  }
  if (extension === "doc" || extension === "ppt") {
    if (!startsWith(firstBytes, OLE2_MAGIC)) return { valid: false, reason: "The file does not have a valid legacy Office signature." };
    return { valid: true };
  }
  if (extension === "docx" || extension === "pptx") {
    // OOXML is a ZIP container. A ZIP magic check is deliberately lightweight;
    // deeper package inspection is out of scope for this storage gateway.
    if (!startsWith(firstBytes, ZIP_MAGIC)) return { valid: false, reason: "The file does not have a valid Office Open XML signature." };
    return { valid: true };
  }
  // Plain text is intentionally accepted on extension/MIME only.
  return { valid: true };
}

export function assertDocumentMetadata(
  name: string,
  size: number,
  maximumSize: number,
  suppliedMimeType?: string,
): { extension: SupportedDocumentExtension; mimeType: string } {
  const extension = getDocumentExtension(name);
  if (!extension) {
    throw new ApiError(400, "INVALID_FILE_TYPE", "Only PDF, DOC, DOCX, TXT, PPT, and PPTX documents can be uploaded.");
  }
  const normalizedMimeType = (suppliedMimeType ?? "").trim().toLowerCase().split(";")[0];
  if (normalizedMimeType) {
    const knownExtension = DOCUMENT_EXTENSION_BY_MIME[normalizedMimeType];
    if (knownExtension && knownExtension !== extension) {
      throw new ApiError(400, "INVALID_FILE_TYPE", "The document content type does not match its file extension.");
    }
  }
  if (!Number.isSafeInteger(size) || size <= 0) throw new ApiError(400, "INVALID_FILE_SIZE", "The document file size is invalid.");
  if (size > maximumSize) throw new ApiError(413, "FILE_TOO_LARGE", "This document exceeds the configured maximum file size.");
  return { extension, mimeType: documentMimeTypeFor(extension, suppliedMimeType) };
}

export function assertValidatedR2Document(input: {
  originalName: string;
  expectedSize: number;
  actualSize?: number;
  contentType?: string;
  firstBytes: Uint8Array;
  lastBytes: Uint8Array;
  objectFileId?: string;
  expectedFileId: string;
}): void {
  const metadata = assertDocumentMetadata(input.originalName, input.expectedSize, input.expectedSize, input.contentType);
  if (input.actualSize !== input.expectedSize) {
    throw new ApiError(400, "UPLOAD_SIZE_MISMATCH", "The uploaded file size could not be verified.");
  }
  const normalizedContentType = (input.contentType ?? "").toLowerCase().split(";")[0];
  if (normalizedContentType && normalizedContentType !== metadata.mimeType && normalizedContentType !== "application/octet-stream") {
    throw new ApiError(400, "INVALID_FILE_TYPE", "The uploaded object content type does not match the document type.");
  }
  if (input.objectFileId !== input.expectedFileId) {
    throw new ApiError(400, "UPLOAD_OWNERSHIP_MISMATCH", "The upload authorization could not be verified.");
  }
  const result = inspectDocumentSignature(metadata.extension, input.firstBytes, input.lastBytes);
  if (!result.valid) throw new ApiError(400, "INVALID_DOCUMENT", result.reason ?? "The uploaded file is not a valid document.");
}

export function stripDocumentExtension(name: string): string {
  return stripPdfLikeSuffix(name.trim());
}
