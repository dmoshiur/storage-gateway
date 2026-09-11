export const FILE_STATUSES = ["uploading", "active", "trash", "deleting", "deleted", "failed"] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

export const DOCUMENT_EXTENSIONS = ["pdf"] as const;
export type DocumentExtension = (typeof DOCUMENT_EXTENSIONS)[number];

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

/** This is the server-side PostgreSQL shape. Date values become Timestamps after reads. */
export interface FileDocument {
  id: string;
  /** Private Vercel Blob pathname, e.g. `pdfs/2026/09/<uuid>.pdf`. UUID-based, never user input. */
  storagePath: string;
  /** Legacy staging pathname (pre-Blob two-phase uploads). Always null for new uploads. */
  uploadKey: string | null;
  originalName: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  mimeType: string;
  extension: string;
  size: number;
  /** SHA-256 hex of the file bytes, when known. Used for duplicate detection. */
  contentHash: string | null;
  createdAt: Date;
  updatedAt: Date;
  uploadedBy: string;
  isFavorite: boolean;
  autoDeleteEnabled: boolean;
  retentionType: RetentionType;
  customDeleteAt: Date | null;
  deleteAt: Date | null;
  status: FileStatus;
  deletedAt: Date | null;
  deletedBy: string | null;
  permanentDeleteAt: Date | null;
  permanentlyDeletedAt: Date | null;
  deletionStartedAt: Date | null;
  deletionPreviousStatus: "active" | "trash" | null;
  deletionReason: DeletionReason;
  uploadExpiresAt: Date | null;
  validatedAt: Date | null;
  lastAccessedAt: Date | null;
  lastDownloadedAt: Date | null;
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
  mimeType: string;
  extension: string;
  size: number;
  contentHash: string | null;
  createdAt: string;
  updatedAt: string;
  uploadedBy: string;
  isFavorite: boolean;
  autoDeleteEnabled: boolean;
  retentionType: RetentionType;
  customDeleteAt: string | null;
  deleteAt: string | null;
  status: FileStatus;
  deletedAt: string | null;
  deletedBy: string | null;
  permanentDeleteAt: string | null;
  permanentlyDeletedAt: string | null;
  deletionStartedAt: string | null;
  deletionReason: DeletionReason;
  lastAccessedAt: string | null;
  lastDownloadedAt: string | null;
  failureCode: string | null;
}

export type FileSort = "newest" | "oldest" | "largest" | "smallest" | "delete_date" | "name";
export type FileFilter =
  | "all"
  | "active"
  | "trash"
  | "auto_delete"
  | "never_delete"
  | "expiring_soon"
  | "expired"
  | "favorites"
  | "recent";
