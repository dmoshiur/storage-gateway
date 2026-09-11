import "server-only";

import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { getFirebaseAdminEnv } from "@/lib/env";

let app: App | undefined;
let initError: Error | null = null;

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
