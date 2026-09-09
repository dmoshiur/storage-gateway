import type { FileStatus } from "@/types/file";

const transitions: Record<FileStatus, readonly FileStatus[]> = {
  uploading: ["active", "failed"],
  active: ["trash", "deleting"],
  trash: ["active", "deleting"],
  deleting: ["trash", "deleted"],
  deleted: [],
  failed: ["deleted"],
};

/** Explicit lifecycle policy used for documentation, tests, and future adapters. */
export function canTransitionFileStatus(from: FileStatus, to: FileStatus): boolean {
  return transitions[from].includes(to);
}
