import "server-only";

import { R2StorageService } from "@/lib/storage/r2-storage";
import type { StorageService } from "@/lib/storage/storage-service";

let storage: StorageService | undefined;

export function getStorageService(): StorageService {
  storage ??= new R2StorageService();
  return storage;
}
