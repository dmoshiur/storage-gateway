import { ApiError } from "@/lib/api/errors";
import {
  assertDocumentMetadata,
  assertValidatedBlobDocument,
  getDocumentExtension,
  inspectDocumentSignature,
} from "@/lib/validation/documents";

/**
 * Backward-compatible PDF-only helpers. New code should import from
 * `@/lib/validation/documents` so PDF, DOC, DOCX, TXT, PPT, and PPTX uploads
 * share one validation path.
 */
export function hasPdfExtension(name: string): boolean {
  return getDocumentExtension(name.trim()) === "pdf";
}

export function inspectPdfSignature(firstBytes: Uint8Array, lastBytes?: Uint8Array): { valid: boolean; reason?: string } {
  return inspectDocumentSignature("pdf", firstBytes, lastBytes);
}

export function assertUploadMetadata(name: string, size: number, maximumSize: number, suppliedMimeType?: string): { extension: "pdf"; mimeType: string } {
  const metadata = assertDocumentMetadata(name, size, maximumSize, suppliedMimeType);
  if (metadata.extension !== "pdf") throw new ApiError(400, "INVALID_FILE_TYPE", "Only PDF files can be uploaded.");
  return { extension: "pdf", mimeType: metadata.mimeType };
}

export function assertValidatedBlobPdf(input: {
  originalName: string;
  expectedSize: number;
  actualSize?: number;
  contentType?: string;
  firstBytes: Uint8Array;
  lastBytes: Uint8Array;
  objectFileId?: string;
  expectedFileId: string;
}): void {
  assertValidatedBlobDocument(input);
}
