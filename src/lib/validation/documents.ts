import { ApiError } from "@/lib/api/errors";

/** The gateway stores and serves PDF files only. */
export const SUPPORTED_DOCUMENT_EXTENSIONS = ["pdf"] as const;
export type SupportedDocumentExtension = (typeof SUPPORTED_DOCUMENT_EXTENSIONS)[number];

export const DOCUMENT_MIME_BY_EXTENSION: Record<SupportedDocumentExtension, string> = {
  pdf: "application/pdf",
};

export const DOCUMENT_EXTENSION_BY_MIME: Record<string, SupportedDocumentExtension> = {
  "application/pdf": "pdf",
};

export const DOCUMENT_ACCEPT = ".pdf";

const PDF_HEADER = /^%PDF-(?:1\.[0-7]|2\.0)(?:[\s%]|$)/;

export function getDocumentExtension(name: string): SupportedDocumentExtension | null {
  const match = name.trim().match(/\.([A-Za-z0-9]+)$/);
  return match?.[1]?.toLowerCase() === "pdf" ? "pdf" : null;
}

export function documentMimeTypeFor(extension: SupportedDocumentExtension, suppliedMimeType?: string): string {
  const normalized = (suppliedMimeType ?? "").trim().toLowerCase().split(";")[0];
  return normalized === "application/pdf" ? normalized : DOCUMENT_MIME_BY_EXTENSION[extension];
}

export function startsWith(bytes: Uint8Array, magic: Uint8Array): boolean {
  if (bytes.length < magic.length) return false;
  for (let index = 0; index < magic.length; index += 1) {
    if (bytes[index] !== magic[index]) return false;
  }
  return true;
}

export function inspectDocumentSignature(extension: SupportedDocumentExtension, firstBytes: Uint8Array, lastBytes?: Uint8Array): { valid: boolean; reason?: string } {
  if (extension !== "pdf") return { valid: false, reason: "Only PDF files can be stored." };
  const head = new TextDecoder("latin1").decode(firstBytes.subarray(0, 64));
  if (!PDF_HEADER.test(head)) return { valid: false, reason: "The file does not have a valid PDF header." };
  if (lastBytes) {
    const tail = new TextDecoder("latin1").decode(lastBytes).replace(/[\0\t\n\r\f ]+$/g, "");
    if (!tail.includes("%%EOF")) return { valid: false, reason: "The file is missing a valid PDF end marker." };
  }
  return { valid: true };
}

export function assertDocumentMetadata(
  name: string,
  size: number,
  maximumSize: number,
  suppliedMimeType?: string,
): { extension: SupportedDocumentExtension; mimeType: string } {
  const extension = getDocumentExtension(name);
  if (!extension) throw new ApiError(400, "INVALID_FILE_TYPE", "Only PDF files can be uploaded.");
  const normalizedMimeType = (suppliedMimeType ?? "").trim().toLowerCase().split(";")[0];
  if (normalizedMimeType && normalizedMimeType !== "application/pdf" && normalizedMimeType !== "application/octet-stream") {
    throw new ApiError(400, "INVALID_FILE_TYPE", "Only application/pdf content is accepted.");
  }
  if (!Number.isSafeInteger(size) || size <= 0) throw new ApiError(400, "INVALID_FILE_SIZE", "The PDF file size is invalid.");
  if (size > maximumSize) throw new ApiError(413, "FILE_TOO_LARGE", "This PDF exceeds the configured maximum file size.");
  return { extension, mimeType: documentMimeTypeFor(extension, suppliedMimeType) };
}

export function assertValidatedBlobDocument(input: {
  originalName: string;
  expectedSize: number;
  actualSize?: number;
  contentType?: string;
  firstBytes: Uint8Array;
  lastBytes: Uint8Array;
  objectFileId?: string;
  expectedFileId?: string;
}): void {
  const metadata = assertDocumentMetadata(input.originalName, input.expectedSize, input.expectedSize, input.contentType);
  if (input.actualSize !== input.expectedSize) {
    throw new ApiError(400, "UPLOAD_SIZE_MISMATCH", "The uploaded PDF size could not be verified.");
  }
  const normalizedContentType = (input.contentType ?? "").toLowerCase().split(";")[0];
  if (normalizedContentType && normalizedContentType !== metadata.mimeType && normalizedContentType !== "application/octet-stream") {
    throw new ApiError(400, "INVALID_FILE_TYPE", "The uploaded object must have application/pdf content type.");
  }
  if (input.expectedFileId && input.objectFileId && input.objectFileId !== input.expectedFileId) {
    throw new ApiError(400, "UPLOAD_OWNERSHIP_MISMATCH", "The upload authorization could not be verified.");
  }
  const result = inspectDocumentSignature(metadata.extension, input.firstBytes, input.lastBytes);
  if (!result.valid) throw new ApiError(400, "INVALID_DOCUMENT", result.reason ?? "The uploaded file is not a valid PDF.");
}

export function stripDocumentExtension(name: string): string {
  return name.trim().replace(/\.pdf$/i, "");
}
