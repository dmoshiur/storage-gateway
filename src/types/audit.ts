export const AUDIT_ACTIONS = [
  "LOGIN",
  "LOGOUT",
  "UPLOAD",
  "UPLOAD_FAILED",
  "DOWNLOAD",
  "UPDATE_METADATA",
  "CHANGE_RETENTION",
  "MOVE_TO_TRASH",
  "RESTORE",
  "PERMANENT_DELETE",
  "AUTO_DELETE",
  "TRASH_EXPIRY_DELETE",
  "SETTINGS_CHANGE",
  "CLEANUP_FAILURE",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditActor {
  uid: string;
  email: string | null;
  type: "admin" | "integration" | "system";
}

export interface AuditLogDocument {
  action: AuditAction;
  actor: AuditActor;
  fileId?: string;
  fileName?: string;
  details?: Record<string, string | number | boolean | null>;
  createdAt: Date;
}

export interface SerializedAuditLog extends Omit<AuditLogDocument, "createdAt"> {
  id: string;
  createdAt: string;
}
