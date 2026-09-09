export const ROLES = ["admin", "editor", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export interface SessionActor {
  uid: string;
  email: string | null;
  role: Role;
  type: "admin";
}

export interface IntegrationActor {
  uid: "website-integration";
  email: null;
  role: "viewer";
  type: "integration";
}

export interface SystemActor {
  uid: "scheduled-cleanup";
  email: null;
  role: "admin";
  type: "system";
}

export type RequestActor = SessionActor | IntegrationActor | SystemActor;
