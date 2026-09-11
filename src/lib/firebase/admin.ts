import "server-only";

import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { getFirebaseAdminEnv } from "@/lib/env";
import { logger } from "@/lib/logging/logger";

let app: App | undefined;
let initError: Error | null = null;

export interface AdminCredentialIdentity {
  /** Project the Admin SDK queries (`FIREBASE_PROJECT_ID`). */
  projectId: string | null;
  /**
   * Project the service account belongs to, derived from
   * `FIREBASE_CLIENT_EMAIL` (`…@<project>.iam.gserviceaccount.com`).
   * `null` when the email is not a standard IAM service account, in which case
   * no conclusion can be drawn — never guessed.
   */
  credentialProjectId: string | null;
  /** `null` when the credential project could not be determined. */
  projectMatch: boolean | null;
}

/**
 * Catches the misconfiguration behind a wall of Firestore PERMISSION_DENIED
 * errors: a service account from project A combined with
 * `FIREBASE_PROJECT_ID=B`. Reads then target a database the credential has no
 * access to, which reads exactly like "the files collection is broken".
 *
 * Only the standard `*.iam.gserviceaccount.com` form is interpreted; anything
 * else yields `null` rather than a false alarm. Never logs the key itself.
 */
export function describeAdminCredentialIdentity(): AdminCredentialIdentity {
  const projectId = process.env.FIREBASE_PROJECT_ID?.trim() || null;
  const email = process.env.FIREBASE_CLIENT_EMAIL?.trim().toLowerCase() ?? "";
  const match = email.match(/^[^@\s]+@([a-z0-9-]+)\.iam\.gserviceaccount\.com$/);
  const credentialProjectId = match?.[1] ?? null;
  return {
    projectId,
    credentialProjectId,
    projectMatch: credentialProjectId && projectId ? credentialProjectId === projectId : null,
  };
}

function normalizePrivateKey(raw: string): string {
  // Vercel env vars may contain escaped newlines (\n) or actual newlines, plus surrounding quotes.
  let key = raw.trim();
  // Remove surrounding quotes if present (common when pasting JSON key).
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1);
  }
  // Handle escaped newlines.
  key = key.replace(/\\n/g, "\n");
  return key;
}

export function getFirebaseAdminApp(): App {
  if (app) return app;
  if (getApps().length) {
    app = getApps()[0]!;
    return app;
  }
  if (initError) throw initError;
  try {
    const env = getFirebaseAdminEnv();
    const privateKey = normalizePrivateKey(env.FIREBASE_PRIVATE_KEY);
    if (!privateKey.includes("BEGIN PRIVATE KEY")) {
      throw new Error("FIREBASE_PRIVATE_KEY does not contain a valid private key header.");
    }
    app = initializeApp({
      credential: cert({
        projectId: env.FIREBASE_PROJECT_ID,
        clientEmail: env.FIREBASE_CLIENT_EMAIL,
        privateKey,
      }),
    });
    // A credential from a different project than FIREBASE_PROJECT_ID produces
    // Firestore PERMISSION_DENIED on every read. Say so once, at init, with
    // both ids (never the key) instead of leaving it to be inferred later.
    const identity = describeAdminCredentialIdentity();
    if (identity.projectMatch === false) {
      logger.warn("Firebase Admin credential belongs to a different project than FIREBASE_PROJECT_ID", {
        projectId: identity.projectId,
        credentialProjectId: identity.credentialProjectId,
        hint: "Regenerate the private key from the service account of the project that owns the `files` collection, or set FIREBASE_PROJECT_ID to the credential's project, then redeploy.",
      });
    }
    return app;
  } catch (error) {
    initError = error instanceof Error ? error : new Error(String(error));
    throw initError;
  }
}

export function getAdminAuth(): Auth {
  return getAuth(getFirebaseAdminApp());
}

export function getAdminDb(): Firestore {
  const db = getFirestore(getFirebaseAdminApp());
  // Ensure timestampsInSnapshots behavior is consistent (admin SDK defaults are fine, but be explicit).
  try {
    db.settings({ ignoreUndefinedProperties: true });
  } catch {
    // Settings can only be set once, ignore if already configured.
  }
  return db;
}

/** For health checks: returns whether admin is configured without throwing. */
export function isFirebaseAdminConfigured(): boolean {
  try {
    getFirebaseAdminApp();
    return true;
  } catch {
    return false;
  }
}
