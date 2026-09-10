import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/errors";
import {
  assertDocumentMetadata,
  assertValidatedR2Document,
  inspectDocumentSignature,
} from "@/lib/validation/documents";
import { getDocumentExtension } from "@/lib/validation/documents";

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function binaryBytes(values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function assertStatus(fn: () => unknown, status: number): void {
  try {
    fn();
    throw new Error("Expected a rejected validation");
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(status);
  }
}

describe("document validation", () => {
  it("accepts PDF, DOC, DOCX, TXT, PPT, and PPTX extensions", () => {
    expect(getDocumentExtension("report.pdf")).toBe("pdf");
    expect(getDocumentExtension("legacy.doc")).toBe("doc");
    expect(getDocumentExtension("letter.docx")).toBe("docx");
    expect(getDocumentExtension("notes.txt")).toBe("txt");
    expect(getDocumentExtension("slides.ppt")).toBe("ppt");
    expect(getDocumentExtension("slides.pptx")).toBe("pptx");
    expect(getDocumentExtension("malware.exe")).toBeNull();
  });

  it("returns the right MIME type for supported documents", () => {
    expect(assertDocumentMetadata("report.pdf", 10, 100).mimeType).toBe("application/pdf");
    expect(assertDocumentMetadata("report.docx", 10, 100).mimeType).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(assertDocumentMetadata("notes.txt", 10, 100).mimeType).toBe("text/plain");
    expect(assertDocumentMetadata("slides.pptx", 10, 100).mimeType).toBe("application/vnd.openxmlformats-officedocument.presentationml.presentation");
  });

  it("rejects unsupported extensions, zero size, and oversized files", () => {
    assertStatus(() => assertDocumentMetadata("notes.exe", 10, 100), 400);
    assertStatus(() => assertDocumentMetadata("report.pdf", 0, 100), 400);
    assertStatus(() => assertDocumentMetadata("report.pdf", 200, 100), 413);
  });

  it("sniffs common document signatures", () => {
    expect(inspectDocumentSignature("pdf", bytes("%PDF-1.7\nsome body"), bytes("xref\n%%EOF\n")).valid).toBe(true);
    expect(inspectDocumentSignature("pdf", bytes("<html>"), bytes("</html>")).valid).toBe(false);
    expect(inspectDocumentSignature("docx", bytes("PK\x03\x04rest"), undefined).valid).toBe(true);
    expect(inspectDocumentSignature("doc", binaryBytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), undefined).valid).toBe(true);
    expect(inspectDocumentSignature("txt", bytes("plain text"), undefined).valid).toBe(true);
  });

  it("verifies a validated R2 document object", () => {
    expect(() => assertValidatedR2Document({
      originalName: "slides.pptx",
      expectedSize: 128,
      actualSize: 128,
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      firstBytes: bytes("PK\x03\x04"),
      lastBytes: bytes(""),
      objectFileId: "file-1",
      expectedFileId: "file-1",
    })).not.toThrow();
  });
});
