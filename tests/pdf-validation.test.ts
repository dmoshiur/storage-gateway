import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/errors";
import { assertUploadMetadata, assertValidatedR2Pdf, inspectPdfSignature } from "@/lib/validation/pdf";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("PDF validation", () => {
  it("accepts a structurally valid PDF signature and end marker", () => {
    expect(inspectPdfSignature(bytes("%PDF-1.7\n%binary"), bytes("xref\n%%EOF\n")).valid).toBe(true);
  });
  it("rejects a file that only claims to be a PDF", () => {
    expect(inspectPdfSignature(bytes("<html>not a PDF"), bytes("</html>")).valid).toBe(false);
    expect(() => assertUploadMetadata("document.txt", 10, 100)).toThrow(ApiError);
  });
  it("rejects oversized uploads before a signed URL is generated", () => {
    expect(() => assertUploadMetadata("record.pdf", 101, 100)).toThrow(ApiError);
  });
  it("rejects R2 metadata, size, or ownership mismatches", () => {
    const valid = { originalName: "record.pdf", expectedSize: 80, actualSize: 80, contentType: "application/pdf", firstBytes: bytes("%PDF-1.4\n"), lastBytes: bytes("%%EOF"), objectFileId: "file-1", expectedFileId: "file-1" };
    expect(() => assertValidatedR2Pdf(valid)).not.toThrow();
    expect(() => assertValidatedR2Pdf({ ...valid, actualSize: 79 })).toThrow(ApiError);
    expect(() => assertValidatedR2Pdf({ ...valid, objectFileId: "other" })).toThrow(ApiError);
  });
});
