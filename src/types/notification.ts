export const NOTIFICATION_TYPES = [
  "storage_warning",
  "storage_critical",
  "cleanup_completed",
  "cleanup_failed",
  "file_expiring",
  "api_key_created",
  "api_key_revoked",
  "api_key_expiring",
  "security_event",
  "upload_failed",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export interface NotificationDocument {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  link: string | null;
  read: boolean;
  createdAt: Date;
}

export interface SerializedNotification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  link: string | null;
  read: boolean;
  createdAt: string;
}
