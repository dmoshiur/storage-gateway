import type { FileDocument } from "@/types/file";

export function isDueForAutomaticCleanup(file: Pick<FileDocument, "status" | "autoDeleteEnabled" | "deleteAt">, now: Date): boolean {
  return file.status === "active" && file.autoDeleteEnabled && Boolean(file.deleteAt && file.deleteAt <= now);
}

export function isDueForTrashExpiry(file: Pick<FileDocument, "status" | "permanentDeleteAt">, now: Date): boolean {
  return file.status === "trash" && Boolean(file.permanentDeleteAt && file.permanentDeleteAt <= now);
}

export function isStaleUpload(file: Pick<FileDocument, "status" | "uploadExpiresAt">, now: Date): boolean {
  return file.status === "uploading" && Boolean(file.uploadExpiresAt && file.uploadExpiresAt <= now);
}
