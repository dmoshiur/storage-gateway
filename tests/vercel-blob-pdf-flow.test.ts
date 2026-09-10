import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const blobList = vi.fn();
const blobPut = vi.fn();
const blobGet = vi.fn();
const blobDelete = vi.fn();
const blobHead = vi.fn();
const issueSignedToken = vi.fn();
const presignUrl = vi.fn();
const getDownloadUrl = vi.fn((url: string) => `${url}?download=1`);

vi.mock("@vercel/blob", () => ({
  BlobAccessError: class BlobAccessError extends Error {},
  BlobNotFoundError: class BlobNotFoundError extends Error {},
  list: blobList,
  put: blobPut,
  get: blobGet,
  del: blobDelete,
  head: blobHead,
  copy: vi.fn(),
  issueSignedToken,
  presignUrl,
  getDownloadUrl,
}));

describe("Vercel Private Blob PDF upload / list / preview / download / delete", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_test";
    blobList.mockReset();
    blobPut.mockReset();
    blobGet.mockReset();
    blobDelete.mockReset();
    blobHead.mockReset();
    issueSignedToken.mockReset();
    presignUrl.mockReset();
  });

  it("uploads a PDF privately, lists it, mints signed preview/download URLs, and deletes it", async () => {
    const pathname = "pdfs/2026/09/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.pdf";
    const privateUrl = `https://blob.vercel-storage.com/${pathname}`;
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // %PDF-1.7

    blobPut.mockResolvedValue({ url: privateUrl, pathname });
    blobList.mockResolvedValue({ blobs: [{ url: privateUrl, pathname }] });
    blobHead.mockResolvedValue({
      size: pdfBytes.byteLength,
      contentType: "application/pdf",
      etag: "\"1\"",
      uploadedAt: new Date("2026-09-10T00:00:00.000Z"),
    });
    blobGet.mockResolvedValue({
      statusCode: 200,
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue(pdfBytes);
          controller.close();
        },
      }),
    });
    issueSignedToken.mockResolvedValue("signed-token");
    presignUrl.mockImplementation(async (_token: string, options: { operation: string }) => ({
      presignedUrl: `https://blob.vercel-storage.com/${pathname}?sig=${options.operation}&exp=short`,
    }));
    blobDelete.mockResolvedValue(undefined);

    const { VercelBlobStorageService } = await import("@/lib/storage/vercel-blob");
    const storage = new VercelBlobStorageService();

    const uploaded = await storage.upload({
      pathname,
      body: pdfBytes,
      contentType: "application/pdf",
      contentLength: pdfBytes.byteLength,
    });
    expect(uploaded.url).toBe(privateUrl);
    expect(blobPut).toHaveBeenCalledWith(
      pathname,
      expect.anything(),
      expect.objectContaining({ access: "private", contentType: "application/pdf" }),
    );

    expect(await storage.exists(pathname)).toBe(true);
    const metadata = await storage.getMetadata(pathname);
    expect(metadata.contentType).toBe("application/pdf");
    expect(metadata.contentLength).toBe(pdfBytes.byteLength);

    const downloaded = await storage.download(pathname);
    expect([...downloaded]).toEqual([...pdfBytes]);

    const previewUrl = await storage.getSignedUrl(pathname, {
      expiresInSeconds: 120,
      disposition: "inline",
      filename: "report.pdf",
      contentType: "application/pdf",
    });
    expect(previewUrl).toContain("sig=get");
    expect(previewUrl).not.toBe(privateUrl);

    const downloadUrl = await storage.getSignedUrl(pathname, {
      expiresInSeconds: 120,
      disposition: "attachment",
      filename: "report.pdf",
      contentType: "application/pdf",
    });
    expect(downloadUrl).toContain("download=1");

    await storage.delete(pathname);
    expect(blobDelete).toHaveBeenCalledWith(privateUrl, expect.anything());
  });

  it("healthCheck returns the exact configuration error instead of a generic message", async () => {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.BLOB_STORE_ID;
    delete process.env.VERCEL_OIDC_TOKEN;
    const { VercelBlobStorageService } = await import("@/lib/storage/vercel-blob");
    const health = await new VercelBlobStorageService().healthCheck();
    expect(health.reachable).toBe(false);
    expect(health.error).toContain("Vercel Blob Private Store is not connected");
    expect(health.error).not.toMatch(/isn't configured yet/i);
  });
});
