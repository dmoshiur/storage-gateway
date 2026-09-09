import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import type { SessionActor } from "@/types/auth";

/** Profiles are operational metadata only; custom claims remain the authority for roles. */
export async function recordAdminLogin(actor: SessionActor): Promise<void> {
  await getAdminDb().collection("users").doc(actor.uid).set({
    uid: actor.uid,
    email: actor.email,
    lastLoginAt: new Date(),
    lastKnownRole: actor.role,
    updatedAt: new Date(),
  }, { merge: true });
}
