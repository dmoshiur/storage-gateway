"use client";

import { deleteApp, getApps, initializeApp, type FirebaseApp, type FirebaseOptions } from "firebase/app";
import { browserLocalPersistence, getAuth, setPersistence, type Auth } from "firebase/auth";
import {
  envVarsToFirebaseConfig,
  firebaseConfigsEqual,
  type FirebaseRuntimeStatus,
  type FirebaseWebConfig,
} from "@/lib/firebase/web-config";

/**
 * Runtime-aware Firebase Web SDK initialization — single source of truth.
 *
 * Resolution order for the effective config:
 *   1. Stored override from GET /api/firebase-config (managed in Settings →
 *      Firebase Configuration, persisted in Firestore `settings/firebase`).
 *   2. Build-time NEXT_PUBLIC_FIREBASE_* baseline (fallback + fresh builds).
 *
 * The async getters below must be used by interactive flows (login,
 * Settings) so a freshly saved config takes effect without a reload. The
 * sync getters keep working (env baseline, or an already-applied override)
 * for code paths that cannot await (initial render, sign-out cleanup).
 */

export interface FirebasePublicConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  measurementId?: string;
}

const DEFAULT_APP_NAME = "[DEFAULT]";
const RUNTIME_CACHE_TTL_MS = 5 * 60 * 1000;

function readEnvConfig(): { config: FirebaseWebConfig | null; missing: string[] } {
  return envVarsToFirebaseConfig({
    NEXT_PUBLIC_FIREBASE_API_KEY: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    NEXT_PUBLIC_FIREBASE_APP_ID: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
    NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
  });
}

function toFirebaseOptions(config: FirebaseWebConfig): FirebaseOptions {
  return {
    apiKey: config.apiKey,
    authDomain: config.authDomain,
    projectId: config.projectId,
    appId: config.appId,
    ...(config.storageBucket ? { storageBucket: config.storageBucket } : {}),
    ...(config.messagingSenderId ? { messagingSenderId: config.messagingSenderId } : {}),
    ...(config.measurementId ? { measurementId: config.measurementId } : {}),
  };
}

function optionsFromApp(app: FirebaseApp): FirebaseWebConfig | null {
  const options = app.options;
  if (!options.apiKey || !options.authDomain || !options.projectId || !options.appId) return null;
  return {
    apiKey: options.apiKey,
    authDomain: options.authDomain,
    projectId: options.projectId,
    appId: options.appId,
    ...(options.storageBucket ? { storageBucket: options.storageBucket } : {}),
    ...(options.messagingSenderId ? { messagingSenderId: options.messagingSenderId } : {}),
    ...(options.measurementId ? { measurementId: options.measurementId as string } : {}),
  };
}

function missingConfigError(missing: string[]): Error {
  return new Error(
    `Firebase sign-in is not configured for this environment. Missing: ${missing.join(", ")}. ` +
      "An administrator can paste the Web App config in Settings → Firebase Configuration, or set these in Vercel Project Settings → Environment Variables and redeploy. " +
      "Also add your production domain to Firebase Console → Authentication → Settings → Authorized domains.",
  );
}

let runtimeStatus: FirebaseRuntimeStatus | null = null;
let runtimeFetchedAt = 0;
let runtimePromise: Promise<FirebaseRuntimeStatus | null> | null = null;
let persistenceConfiguredFor: FirebaseApp | null = null;

export function resetFirebaseRuntimeCache(): void {
  runtimeStatus = null;
  runtimeFetchedAt = 0;
  runtimePromise = null;
}

/** Fetches the effective config; resolves to null on network failure (caller falls back to env). */
export function fetchFirebaseRuntimeStatus(signal?: AbortSignal): Promise<FirebaseRuntimeStatus | null> {
  if (runtimeStatus && Date.now() - runtimeFetchedAt < RUNTIME_CACHE_TTL_MS) return Promise.resolve(runtimeStatus);
  if (runtimePromise) return runtimePromise;
  runtimePromise = (async () => {
    try {
      const response = await fetch("/api/firebase-config", { credentials: "same-origin", cache: "no-store", signal });
      const payload = (await response.json()) as { success?: boolean; data?: FirebaseRuntimeStatus };
      if (!response.ok || !payload.success || !payload.data) return null;
      runtimeStatus = payload.data;
      runtimeFetchedAt = Date.now();
      return runtimeStatus;
    } catch {
      return null;
    } finally {
      runtimePromise = null;
    }
  })();
  return runtimePromise;
}

function ensurePersistence(auth: Auth, app: FirebaseApp): void {
  if (persistenceConfiguredFor === app || typeof window === "undefined") return;
  persistenceConfiguredFor = app;
  setPersistence(auth, browserLocalPersistence).catch((error) => {
    console.warn("Firebase Auth persistence setup failed:", error);
  });
}

/**
 * Binds Firestore to the given app, so every Firestore client call runs
 * against the SAME project the app was initialized for. Firestore is
 * imported on demand to keep it out of the initial bundle; a bind failure
 * surfaces through the connection probe rather than crashing boot.
 */
async function bindFirestore(app: FirebaseApp): Promise<void> {
  try {
    const { getFirestore } = await import("firebase/firestore");
    getFirestore(app);
  } catch (error) {
    console.warn("Firebase Firestore binding needs verification:", error);
  }
}

/**
 * Applies a Web config to the default Firebase app, reinitializing the
 * Auth and Firestore SDK bindings when the identity changed. No-op when the
 * default app already runs this exact config. Temporary probe apps are
 * never touched. Every subsequent getAuth()/Firestore lookup on the default
 * app — login, sign-out, probes — uses the new project immediately.
 */
export async function applyFirebaseWebConfig(config: FirebaseWebConfig): Promise<FirebaseApp> {
  const existing = getApps().find((app) => app.name === DEFAULT_APP_NAME) ?? null;
  if (existing) {
    const current = optionsFromApp(existing);
    if (current && firebaseConfigsEqual(current, config)) return existing;
    await deleteApp(existing).catch(() => undefined);
    if (persistenceConfiguredFor === existing) persistenceConfiguredFor = null;
  }
  const app = initializeApp(toFirebaseOptions(config));
  // Bind Auth to the new project immediately (persistence included) so the
  // next sign-in attempt cannot run against a stale project.
  ensurePersistence(getAuth(app), app);
  // Bind Firestore to the new project as well. Firestore is loaded on
  // demand so this never grows the initial bundle; a bind failure here is
  // non-fatal because the post-save connection probe is the source of
  // truth for Firestore reachability and reports the exact reason.
  await bindFirestore(app);
  return app;
}

/** Removes the default app (used on Reset when no baseline config exists). Probe apps are never touched. */
export async function clearFirebaseDefaultApp(): Promise<void> {
  const existing = getApps().find((app) => app.name === DEFAULT_APP_NAME) ?? null;
  if (existing) await deleteApp(existing).catch(() => undefined);
  if (persistenceConfiguredFor && !getApps().includes(persistenceConfiguredFor)) persistenceConfiguredFor = null;
}

function defaultAppFromEnv(): FirebaseApp {
  const existing = getApps().find((app) => app.name === DEFAULT_APP_NAME) ?? null;
  if (existing) return existing;
  const { config, missing } = readEnvConfig();
  if (!config) throw missingConfigError(missing);
  const app = initializeApp(toFirebaseOptions(config));
  ensurePersistence(getAuth(app), app);
  // Fire-and-forget: Auth must be available synchronously, but Firestore
  // must also be bound to this exact project for any client that uses it.
  void bindFirestore(app);
  return app;
}

export function getFirebaseClientApp(): FirebaseApp {
  const existing = getApps().find((app) => app.name === DEFAULT_APP_NAME) ?? null;
  if (existing) return existing;
  // A stored override may already be cached from an earlier async load.
  if (runtimeStatus?.config) {
    const app = initializeApp(toFirebaseOptions(runtimeStatus.config));
    ensurePersistence(getAuth(app), app);
    void bindFirestore(app);
    return app;
  }
  return defaultAppFromEnv();
}

/** Ensures the stored override (if any) is applied, then returns the default app. */
export async function getFirebaseClientAppAsync(signal?: AbortSignal): Promise<FirebaseApp> {
  const status = await fetchFirebaseRuntimeStatus(signal).catch(() => null);
  if (status?.config) {
    try {
      return await applyFirebaseWebConfig(status.config);
    } catch {
      // Fall through to whatever app exists, or the env baseline.
    }
  }
  const existing = getApps().find((app) => app.name === DEFAULT_APP_NAME) ?? null;
  if (existing) return existing;
  const { config, missing } = readEnvConfig();
  if (!config) throw missingConfigError(status?.missing?.length ? status.missing : missing);
  const app = initializeApp(toFirebaseOptions(config));
  ensurePersistence(getAuth(app), app);
  await bindFirestore(app);
  return app;
}

export function getFirebaseClientAuth(): Auth {
  const app = getFirebaseClientApp();
  const auth = getAuth(app);
  ensurePersistence(auth, app);
  return auth;
}

export async function getFirebaseClientAuthAsync(signal?: AbortSignal): Promise<Auth> {
  const app = await getFirebaseClientAppAsync(signal);
  const auth = getAuth(app);
  ensurePersistence(auth, app);
  return auth;
}

/** Sync build-time baseline status (env only) — for first-render diagnostics. */
export function getFirebaseConfigStatus(): { configured: boolean; missing: string[]; projectId: string | null; authDomain: string | null } {
  const { config, missing } = readEnvConfig();
  return {
    configured: missing.length === 0,
    missing,
    projectId: config?.projectId ?? null,
    authDomain: config?.authDomain ?? null,
  };
}

/** Warms the runtime cache without initializing the SDK (safe fire-and-forget on boot). */
export function warmFirebaseRuntimeCache(): void {
  void fetchFirebaseRuntimeStatus().catch(() => undefined);
}
