"use client";

import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { browserLocalPersistence, getAuth, setPersistence, type Auth } from "firebase/auth";

export interface FirebasePublicConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  messagingSenderId?: string;
}

function readPublicConfig(): { config: FirebasePublicConfig | null; missing: string[] } {
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY?.trim() ?? "";
  const authDomain = process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN?.trim() ?? "";
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.trim() ?? "";
  const appId = process.env.NEXT_PUBLIC_FIREBASE_APP_ID?.trim() ?? "";
  const messagingSenderId = process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID?.trim() || undefined;

  const missing: string[] = [];
  if (!apiKey) missing.push("NEXT_PUBLIC_FIREBASE_API_KEY");
  if (!authDomain) missing.push("NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN");
  if (!projectId) missing.push("NEXT_PUBLIC_FIREBASE_PROJECT_ID");
  if (!appId) missing.push("NEXT_PUBLIC_FIREBASE_APP_ID");

  if (missing.length > 0) return { config: null, missing };
  return { config: { apiKey, authDomain, projectId, appId, messagingSenderId }, missing: [] };
}

function publicConfig(): FirebasePublicConfig {
  const { config, missing } = readPublicConfig();
  if (!config) {
    throw new Error(
      `Firebase sign-in is not configured for this environment. Missing: ${missing.join(", ")}. ` +
        "Set these in Vercel Project Settings → Environment Variables and redeploy. " +
        "Also add your production domain to Firebase Console → Authentication → Settings → Authorized domains.",
    );
  }
  return config;
}

let persistenceConfigured = false;

export function getFirebaseClientApp(): FirebaseApp {
  if (getApps().length) return getApp();
  return initializeApp(publicConfig());
}

export function getFirebaseClientAuth(): Auth {
  const auth = getAuth(getFirebaseClientApp());
  // Ensure session persistence is local (survives page reloads) and only configured once.
  if (!persistenceConfigured && typeof window !== "undefined") {
    persistenceConfigured = true;
    // Non-blocking: persistence setup failure should not break auth flow, but log it.
    setPersistence(auth, browserLocalPersistence).catch((error) => {
      console.warn("Firebase Auth persistence setup failed:", error);
    });
  }
  return auth;
}

/** Exposed for diagnostics in production (never logs values, only presence). */
export function getFirebaseConfigStatus(): { configured: boolean; missing: string[]; projectId: string | null; authDomain: string | null } {
  const { config, missing } = readPublicConfig();
  return {
    configured: missing.length === 0,
    missing,
    projectId: config?.projectId ?? null,
    authDomain: config?.authDomain ?? null,
  };
}
