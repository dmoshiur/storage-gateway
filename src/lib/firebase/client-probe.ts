"use client";

import { deleteApp, initializeApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword } from "firebase/auth";
import type { FirebaseWebConfig } from "@/lib/firebase/web-config";
import {
  fetchFirestoreProbe,
  fetchPasswordProviderProbe,
  fetchProjectConfig,
  mapAuthorizedDomainStep,
  mapConfigConsistencyStep,
  mapFirestoreProbe,
  mapPasswordProviderProbe,
  mapProjectConfigProbe,
  networkFailureStep,
  parseProjectConfigBody,
  summarizeProbe,
  type ProbeReport,
  type ProbeStep,
} from "@/lib/firebase/probe-shared";

/**
 * Browser-side connection probe. Complements the server probe: the server
 * proves Firebase answers from the datacenter (and that the Admin project
 * matches), while this proves the operator's browser can reach Firebase
 * through the deployed network/CSP — using the REAL Firebase JS SDK for
 * initialization and the same REST endpoints the SDK itself calls.
 */

function tempAppName(): string {
  return `gateway-probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function candidateOptions(config: FirebaseWebConfig) {
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

async function probeSdkInitialization(config: FirebaseWebConfig): Promise<ProbeStep> {
  const startedAt = Date.now();
  const name = tempAppName();
  try {
    const app = initializeApp(candidateOptions(config), name);
    // Touching Auth proves the Auth SDK binds to this project; binding
    // Firestore proves the same options resolve a Firestore database.
    getAuth(app);
    const { getFirestore } = await import("firebase/firestore");
    getFirestore(app);
    await deleteApp(app).catch(() => undefined);
    return {
      id: "initialization",
      label: "SDK initialization",
      status: "passed",
      latencyMs: Date.now() - startedAt,
      message: `Firebase Web SDK initialized in this browser for project “${config.projectId}” (Auth and Firestore bound).`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "initialization failed";
    let code = "INIT_FAILED";
    let hint = message.slice(0, 220);
    if (/invalid-api-key|api-key-not-valid/i.test(message)) {
      code = "INVALID_API_KEY";
      hint = "The Firebase SDK rejected the API key as invalid.";
    } else if (/project-not-found|configuration-not-found/i.test(message)) {
      code = "PROJECT_NOT_FOUND";
      hint = "The Firebase SDK could not find this project configuration.";
    } else if (/network/i.test(message)) {
      code = "NETWORK_ERROR";
      hint = "Network error while initializing the Firebase SDK.";
    }
    return { id: "initialization", label: "SDK initialization", status: "failed", code, latencyMs: Date.now() - startedAt, message: `SDK initialization failed: ${hint}` };
  }
}

async function probeProjectConfig(config: FirebaseWebConfig): Promise<{ step: ProbeStep; authorizedDomains: string[] }> {
  const startedAt = Date.now();
  try {
    const { status, bodyText } = await fetchProjectConfig(config);
    const step = mapProjectConfigProbe(
      status,
      bodyText,
      config,
      Date.now() - startedAt,
      "auth-browser",
      "Auth (this browser)",
    );
    return { step, authorizedDomains: status === 200 ? parseProjectConfigBody(bodyText).authorizedDomains : [] };
  } catch (error) {
    return {
      step: networkFailureStep("auth-browser", "Auth (this browser)", error, Date.now() - startedAt),
      authorizedDomains: [],
    };
  }
}

async function probePasswordProvider(config: FirebaseWebConfig): Promise<ProbeStep> {
  const startedAt = Date.now();
  try {
    const { status, bodyText } = await fetchPasswordProviderProbe(config);
    const step = mapPasswordProviderProbe(status, bodyText, Date.now() - startedAt);
    return { ...step, id: "auth-password-browser", label: "Email/Password (this browser)" };
  } catch (error) {
    return networkFailureStep("auth-password-browser", "Email/Password (this browser)", error, Date.now() - startedAt);
  }
}

async function probeAuthorizedDomain(config: FirebaseWebConfig, authorizedDomains: string[]): Promise<ProbeStep | null> {
  const hostname = typeof window !== "undefined" ? window.location.hostname : null;
  return mapAuthorizedDomainStep(
    config,
    authorizedDomains,
    hostname,
    0,
    "auth-domain-browser",
    "Authorized domain (this browser)",
  );
}

async function probeFirestore(config: FirebaseWebConfig): Promise<ProbeStep> {
  const startedAt = Date.now();
  try {
    const { status, bodyText } = await fetchFirestoreProbe(config);
    const step = mapFirestoreProbe(
      status,
      bodyText,
      config,
      Date.now() - startedAt,
      "firestore-browser",
      "Firestore (this browser)",
    );
    return step;
  } catch (error) {
    return networkFailureStep("firestore-browser", "Firestore (this browser)", error, Date.now() - startedAt);
  }
}

export async function probeFirebaseWebConfigClient(config: FirebaseWebConfig): Promise<ProbeReport> {
  const startedAt = Date.now();
  const initialization = await probeSdkInitialization(config);
  const consistency = mapConfigConsistencyStep(
    config,
    0,
    "config-consistency-browser",
    "Config identity (this browser)",
  );
  const [{ step: auth, authorizedDomains }, password, firestore] = await Promise.all([
    probeProjectConfig(config),
    probePasswordProvider(config),
    probeFirestore(config),
  ]);
  const domainStep = await probeAuthorizedDomain(config, authorizedDomains);
  const steps: ProbeStep[] = [
    initialization,
    consistency,
    auth,
    auth.status === "failed"
      ? { ...password, status: "skipped" as const, message: "Skipped: Authentication service check failed first." }
      : password,
    ...(domainStep ? [domainStep] : []),
    firestore,
  ];
  return summarizeProbe(steps, config.projectId, startedAt);
}

export interface ClientLoginVerification {
  idToken: string;
  uid: string;
  email: string | null;
}

function mapSignInError(error: unknown): Error {
  const code = (error as { code?: string })?.code ?? "";
  const raw = error instanceof Error ? error.message : String(error);
  if (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found" || code === "auth/invalid-email") {
    return new Error("Invalid email or password for this Firebase project.");
  }
  if (code === "auth/user-disabled") return new Error("This Firebase account is disabled.");
  if (code === "auth/too-many-requests") return new Error("Too many attempts — Firebase temporarily locked this sign-in. Wait and retry.");
  if (code === "auth/network-request-failed") return new Error("Network error contacting Firebase from this browser.");
  if (code === "auth/unauthorized-domain") {
    return new Error("This domain is not in Firebase Console → Authentication → Settings → Authorized domains.");
  }
  if (code === "auth/invalid-api-key" || code === "auth/api-key-not-valid.-please-pass-a-valid-api-key.") {
    return new Error("Firebase rejected the API key as invalid.");
  }
  if (code === "auth/project-not-found" || code === "auth/configuration-not-found") {
    return new Error("Firebase project configuration not found — check the projectId.");
  }
  if (code === "auth/operation-not-allowed") {
    return new Error("Email/Password sign-in is disabled in this Firebase project. Enable it in Firebase Console → Authentication → Sign-in method.");
  }
  if (code.startsWith("auth/")) return new Error(`Firebase sign-in failed (${code}): ${raw.slice(0, 180)}`);
  return new Error(raw.slice(0, 240) || "Sign-in failed.");
}

/**
 * Real sign-in against a candidate config on an isolated temporary Firebase
 * app — the default app (and the operator's current dashboard session) is
 * never touched. Returns a fresh ID token for server-side verification via
 * POST /api/firebase-config/verify-login.
 */
export async function signInToCandidateProject(
  config: FirebaseWebConfig,
  email: string,
  password: string,
): Promise<ClientLoginVerification> {
  const name = tempAppName();
  const app = initializeApp(candidateOptions(config), name);
  try {
    const credential = await signInWithEmailAndPassword(getAuth(app), email.trim(), password);
    const idToken = await credential.user.getIdToken(true);
    return { idToken, uid: credential.user.uid, email: credential.user.email };
  } catch (error) {
    throw mapSignInError(error);
  } finally {
    await deleteApp(app).catch(() => undefined);
  }
}
