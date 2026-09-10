export const AUDIT_ACTIONS = [
  "LOGIN",
  "LOGOUT",
  "LOGIN_FAILED",
  "UPLOAD",
  "UPLOAD_FAILED",
  "BRIDGE_UPLOAD",
  "DOWNLOAD",
  "PREVIEW",
  "FAVORITE",
  "UPDATE_METADATA",
  "CHANGE_RETENTION",
  "BULK_UPDATE",
  "MOVE_TO_TRASH",
  "RESTORE",
  "BULK_TRASH",
  "BULK_RESTORE",
  "EMPTY_TRASH",
  "PERMANENT_DELETE",
  "BULK_DELETE",
  "AUTO_DELETE",
  "TRASH_EXPIRY_DELETE",
  "SETTINGS_CHANGE",
  "API_KEY_CREATED",
  "API_KEY_ROTATED",
  "API_KEY_REVOKED",
  "USER_INVITED",
  "USER_ROLE_CHANGED",
  "USER_DISABLED",
  "USER_ENABLED",
  "WEBHOOK_CREATED",
  "WEBHOOK_UPDATED",
  "WEBHOOK_DELETED",
  "WEBHOOK_TESTED",
  "EXPORT",
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
