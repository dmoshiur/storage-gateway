import "server-only";

import { VercelBlobStorageService } from "@/lib/storage/vercel-blob";
import type { StorageService } from "@/lib/storage/storage-service";

let storage: StorageService | undefined;

export function getStorageService(): StorageService {
  storage ??= new VercelBlobStorageService();
  return storage;
}

export type { StorageService } from "@/lib/storage/storage-service";
