export const FILE_STATUSES = ["uploading", "active", "trash", "deleting", "deleted", "failed"] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

export const RETENTION_TYPES = [
  "never",
  "30_days",
  "3_months",
  "6_months",
  "1_year",
  "custom_date",
] as const;
export type RetentionType = (typeof RETENTION_TYPES)[number];

export type DeletionReason = "manual" | "auto_retention" | "upload_validation" | "cleanup" | null;

/** This is the server-side Firestore shape. Date values become Timestamps after reads. */
export interface FileDocument {
  id: string;
  storageKey: string;
  /** Temporary, signed-upload staging key. Never serialized to callers. */
  uploadKey: string | null;
  originalName: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  mimeType: "application/pdf";
  size: number;
  createdAt: Date;
  updatedAt: Date;
  uploadedBy: string;
  autoDeleteEnabled: boolean;
  retentionType: RetentionType;
  customDeleteAt: Date | null;
  deleteAt: Date | null;
  status: FileStatus;
  deletedAt: Date | null;
  permanentDeleteAt: Date | null;
  permanentlyDeletedAt: Date | null;
  deletionStartedAt: Date | null;
  deletionPreviousStatus: "active" | "trash" | null;
  deletionReason: DeletionReason;
  uploadExpiresAt: Date | null;
  validatedAt: Date | null;
  failureCode: string | null;
  version: number;
}

export interface SerializedFile {
  id: string;
  originalName: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  mimeType: "application/pdf";
  size: number;
  createdAt: string;
  updatedAt: string;
  autoDeleteEnabled: boolean;
  retentionType: RetentionType;
  customDeleteAt: string | null;
  deleteAt: string | null;
  status: FileStatus;
  deletedAt: string | null;
  permanentDeleteAt: string | null;
  permanentlyDeletedAt: string | null;
  deletionStartedAt: string | null;
  deletionReason: DeletionReason;
  failureCode: string | null;
}

export type FileSort = "newest" | "oldest" | "largest" | "smallest" | "delete_date";
export type FileFilter = "all" | "active" | "trash" | "auto_delete" | "never_delete" | "expiring_soon" | "expired";
