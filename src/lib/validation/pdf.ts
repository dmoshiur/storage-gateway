import { ApiError } from "@/lib/api/errors";

const PDF_HEADER = /^%PDF-1\.[0-7](?:[\s%]|$)/;

export function hasPdfExtension(name: string): boolean {
  return /\.pdf$/i.test(name.trim());
}

/** Strict, inexpensive structural gate, not an antivirus scanner. */
export function inspectPdfSignature(firstBytes: Uint8Array, lastBytes?: Uint8Array): { valid: boolean; reason?: string } {
  const header = new TextDecoder("latin1").decode(firstBytes.subarray(0, 32));
  if (!PDF_HEADER.test(header)) return { valid: false, reason: "The file does not have a valid PDF header." };

  if (lastBytes) {
    const tail = new TextDecoder("latin1").decode(lastBytes).replace(/[\0\t\n\r\f ]+$/g, "");
    if (!tail.includes("%%EOF")) return { valid: false, reason: "The file is missing a valid PDF end marker." };
  }
  return { valid: true };
}

export function assertUploadMetadata(name: string, size: number, maximumSize: number): void {
  if (!hasPdfExtension(name)) throw new ApiError(400, "INVALID_FILE_TYPE", "Only PDF files can be uploaded.");
  if (!Number.isSafeInteger(size) || size <= 0) throw new ApiError(400, "INVALID_FILE_SIZE", "The PDF file size is invalid.");
  if (size > maximumSize) throw new ApiError(413, "FILE_TOO_LARGE", "This PDF exceeds the configured maximum file size.");
}

export function assertValidatedR2Pdf(input: {
  originalName: string;
  expectedSize: number;
  actualSize?: number;
  contentType?: string;
  firstBytes: Uint8Array;
  lastBytes: Uint8Array;
  objectFileId?: string;
  expectedFileId: string;
}): void {
  assertUploadMetadata(input.originalName, input.expectedSize, input.expectedSize);
  if (input.actualSize !== input.expectedSize) {
    throw new ApiError(400, "UPLOAD_SIZE_MISMATCH", "The uploaded file size could not be verified.");
  }
  if (input.contentType?.toLowerCase().split(";")[0] !== "application/pdf") {
    throw new ApiError(400, "INVALID_FILE_TYPE", "The uploaded object is not marked as a PDF.");
  }
  if (input.objectFileId !== input.expectedFileId) {
    throw new ApiError(400, "UPLOAD_OWNERSHIP_MISMATCH", "The upload authorization could not be verified.");
  }
  const result = inspectPdfSignature(input.firstBytes, input.lastBytes);
  if (!result.valid) throw new ApiError(400, "INVALID_PDF", "The uploaded file is not a valid PDF document.");
}
