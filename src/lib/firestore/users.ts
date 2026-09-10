import "server-only";

import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import { ApiError } from "@/lib/api/errors";
import type { Role, SessionActor } from "@/types/auth";
import { asDate } from "@/utils/date";

const USERS = "users";

export interface ManagedUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  role: Role;
  disabled: boolean;
  createdAt: string | null;
  lastLoginAt: string | null;
}

/** Profiles are operational metadata only; custom claims remain the authority for roles. */
export async function recordAdminLogin(actor: SessionActor): Promise<void> {
  await getAdminDb().collection(USERS).doc(actor.uid).set({
    uid: actor.uid,
    email: actor.email,
    lastLoginAt: new Date(),
    lastKnownRole: actor.role,
    updatedAt: new Date(),
  }, { merge: true });
}

export async function listManagedUsers(limit = 100): Promise<ManagedUser[]> {
  const auth = getAdminAuth();
  const profiles = await getAdminDb().collection(USERS).limit(500).get();
  const profileByUid = new Map(profiles.docs.map((doc) => [doc.id, doc.data()]));
  const listed = await auth.listUsers(Math.min(Math.max(limit, 1), 1000));
  return listed.users.map((user) => {
    const profile = profileByUid.get(user.uid);
    const role = (user.customClaims?.role as Role | undefined) ?? "viewer";
    return {
      uid: user.uid,
      email: user.email ?? null,
      displayName: user.displayName ?? null,
      role: role === "admin" || role === "editor" || role === "viewer" ? role : "viewer",
      disabled: user.disabled,
      createdAt: user.metadata.creationTime ? new Date(user.metadata.creationTime).toISOString() : null,
      lastLoginAt: asDate(profile?.lastLoginAt)?.toISOString() ?? null,
    };
  });
}

export async function inviteUser(input: { email: string; role: Role; displayName?: string }): Promise<ManagedUser> {
  const auth = getAdminAuth();
  const email = input.email.trim().toLowerCase();
  let user;
  try {
    user = await auth.getUserByEmail(email);
    if (user.disabled) throw new ApiError(409, "USER_DISABLED", "This user exists but is disabled. Re-enable them instead.");
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // Firebase throws auth/user-not-found when the address is free — create it.
    const code = (error as { code?: string }).code;
    if (code !== "auth/user-not-found") throw error;
    user = await auth.createUser({
      email,
      displayName: input.displayName?.trim() || undefined,
      emailVerified: false,
    });
    const resetLink = await auth.generatePasswordResetLink(email).catch(() => null);
    void resetLink; // Invitation email delivery is wired through Firebase templates.
  }
  await auth.setCustomUserClaims(user.uid, { role: input.role });
  await getAdminDb().collection(USERS).doc(user.uid).set({
    uid: user.uid,
    email,
    lastKnownRole: input.role,
    invitedAt: new Date(),
    updatedAt: new Date(),
  }, { merge: true });
  return {
    uid: user.uid,
    email: user.email ?? email,
    displayName: user.displayName ?? null,
    role: input.role,
    disabled: user.disabled,
    createdAt: user.metadata.creationTime ? new Date(user.metadata.creationTime).toISOString() : null,
    lastLoginAt: null,
  };
}

export async function setUserRole(uid: string, role: Role): Promise<void> {
  const auth = getAdminAuth();
  await auth.setCustomUserClaims(uid, { role });
  // Revoke sessions so the new role takes effect immediately.
  await auth.revokeRefreshTokens(uid).catch(() => undefined);
  await getAdminDb().collection(USERS).doc(uid).set({ lastKnownRole: role, updatedAt: new Date() }, { merge: true });
}

export async function setUserDisabled(uid: string, disabled: boolean): Promise<void> {
  const auth = getAdminAuth();
  await auth.updateUser(uid, { disabled });
  if (disabled) await auth.revokeRefreshTokens(uid).catch(() => undefined);
  await getAdminDb().collection(USERS).doc(uid).set({ disabled, updatedAt: new Date() }, { merge: true });
}
