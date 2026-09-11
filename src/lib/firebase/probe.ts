import "server-only";

import { ApiError } from "@/lib/api/errors";
import type { FirebaseWebConfig } from "@/lib/firebase/web-config";
import { validateFirebaseWebConfig } from "@/lib/firebase/web-config";
import { getAdminProjectId } from "@/lib/firebase/runtime-store";
import {
  fetchFirestoreProbe,
  fetchPasswordProviderProbe,
  fetchProjectConfig,
  mapConfigConsistencyStep,
  mapFirestoreProbe,
  mapPasswordProviderProbe,
  mapProjectConfigProbe,
  networkFailureStep,
  summarizeProbe,
  type ProbeReport,
  type ProbeStep,
} from "@/lib/firebase/probe-shared";

/**
 * Authoritative server-side connection probe.
 *
 * Runs the real chain for a candidate (or effective) Web config:
 *   local consistency → Auth (Identity Toolkit, project-number identity) →
 *   Email/Password provider → Firestore (non-reserved probe document;
 *   cross-project CONSUMER_INVALID detection) → Admin SDK project match.
 *
 * Project identity is proven three independent ways:
 *   1. getProjectConfig returns the API key's project NUMBER, which must
 *      equal the number embedded in appId/messagingSenderId.
 *   2. Firestore REST accepts the key for the projectId in the URL (a
 *      cross-project key returns CONSUMER_INVALID).
 *   3. The Admin SDK's FIREBASE_PROJECT_ID equals the string projectId —
 *      this is what lets the browser's ID token verify server-side so
 *      existing Firebase users can sign in.
 */

async function probeProjectConfig(config: FirebaseWebConfig): Promise<ProbeStep> {
  const startedAt = Date.now();
  try {
    const { status, bodyText } = await fetchProjectConfig(config);
    return mapProjectConfigProbe(status, bodyText, config, Date.now() - startedAt);
  } catch (error) {
    return networkFailureStep("auth", "Authentication service", error, Date.now() - startedAt);
  }
}

async function probePasswordProvider(config: FirebaseWebConfig): Promise<ProbeStep> {
  const startedAt = Date.now();
  try {
    const { status, bodyText } = await fetchPasswordProviderProbe(config);
    return mapPasswordProviderProbe(status, bodyText, Date.now() - startedAt);
  } catch (error) {
    return networkFailureStep("auth-password", "Email/Password sign-in", error, Date.now() - startedAt);
  }
}

async function probeFirestore(config: FirebaseWebConfig): Promise<ProbeStep> {
  const startedAt = Date.now();
  try {
    const { status, bodyText } = await fetchFirestoreProbe(config);
    return mapFirestoreProbe(status, bodyText, config, Date.now() - startedAt);
  } catch (error) {
    return networkFailureStep("firestore", "Firestore database", error, Date.now() - startedAt);
  }
}

function probeAdminMatch(config: FirebaseWebConfig): ProbeStep {
  const adminProjectId = getAdminProjectId();
  if (!adminProjectId) {
    return {
      id: "admin-match",
      label: "Server session verification",
      status: "failed",
      code: "ADMIN_NOT_CONFIGURED",
      latencyMs: 0,
      message:
        "Server Firebase Admin is not configured (FIREBASE_PROJECT_ID is missing), so no Firebase sign-in can be verified. " +
        "Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY in Vercel and redeploy.",
    };
  }
  if (adminProjectId !== config.projectId) {
    return {
      id: "admin-match",
      label: "Server session verification",
      status: "failed",
      code: "ADMIN_PROJECT_MISMATCH",
      latencyMs: 0,
      message:
        `Server Admin SDK points at project “${adminProjectId}” but the web config points at “${config.projectId}”. ` +
        "Sign-in tokens from the browser would fail server verification. The server project must not be changed: " +
        `paste the Web App config for project “${adminProjectId}” instead.`,
    };
  }
  return {
    id: "admin-match",
    label: "Server session verification",
    status: "passed",
    latencyMs: 0,
    message: `Server Admin SDK project matches (“${adminProjectId}”) — existing Firebase users can sign in.`,
  };
}

export async function probeFirebaseWebConfigServer(config: FirebaseWebConfig): Promise<ProbeReport> {
  const startedAt = Date.now();
  const consistency = mapConfigConsistencyStep(config, 0, "config-consistency", "Config identity");
  const [auth, password, firestore] = await Promise.all([
    probeProjectConfig(config),
    probePasswordProvider(config),
    probeFirestore(config),
  ]);
  // Skip the provider detail when Auth itself already failed — one exact
  // reason beats two cascading errors.
  const steps: ProbeStep[] = [
    consistency,
    auth,
    auth.status === "failed" ? { ...password, status: "skipped" as const, message: "Skipped: Authentication service check failed first." } : password,
    firestore,
    probeAdminMatch(config),
  ];
  return summarizeProbe(steps, config.projectId, startedAt);
}

/* ---------------- pre-save live identity verification ---------------- */

export interface SaveVerification {
  /** True when no definitive identity error was found. */
  ok: boolean;
  /** False when network errors prevented live verification (save allowed, but honestly flagged). */
  verified: boolean;
  /** Non-blocking observations, e.g. disabled provider. */
  warnings: string[];
  /** Machine-readable blocking code when ok is false. */
  code?: string;
  message?: string;
}

/**
 * Live validation performed BEFORE a web config is persisted.
 *
 * Hard-blocks (definitive evidence):
 *   - CONFIG_INCONSISTENT  — pasted fields disagree with each other locally
 *   - INVALID_API_KEY      — Firebase rejects the apiKey outright
 *   - WRONG_PROJECT        — apiKey/appId/Firestore/Admin resolve to different projects
 *   - ADMIN_PROJECT_MISMATCH / ADMIN_NOT_CONFIGURED
 *   - FIRESTORE_DISABLED   — the target project has no Firestore database
 *
 * Network failures never block a save (an outage would otherwise strand the
 * operator), but the result is returned as verified:false with the exact
 * reason — nothing is reported as a successful connection that was not.
 */
export async function verifyConfigForSave(config: FirebaseWebConfig): Promise<SaveVerification> {
  const local = validateFirebaseWebConfig(config);
  if (!local.ok) {
    return {
      ok: false,
      verified: true,
      warnings: [],
      code: "CONFIG_INCONSISTENT",
      message: `The pasted config is internally inconsistent: ${local.errors.map((e) => e.message).join(" ")}`,
    };
  }

  // Admin project match is local and authoritative — block immediately.
  const adminProjectId = getAdminProjectId();
  if (!adminProjectId) {
    return {
      ok: false,
      verified: true,
      warnings: [],
      code: "ADMIN_NOT_CONFIGURED",
      message:
        "Server Firebase Admin is not configured (FIREBASE_PROJECT_ID), so the web config cannot be persisted or verified. " +
        "Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY in Vercel and redeploy.",
    };
  }
  if (adminProjectId !== config.projectId) {
    return {
      ok: false,
      verified: true,
      warnings: [],
      code: "ADMIN_PROJECT_MISMATCH",
      message:
        `The pasted web config is for project “${config.projectId}”, but the server Admin SDK (which must not be changed) ` +
        `uses project “${adminProjectId}”. Paste the Web App config from inside project “${adminProjectId}”.`,
    };
  }

  const warnings: string[] = [];
  let networkUnverified = false;

  const [projectConfigResult, firestoreResult, passwordResult] = await Promise.all([
    fetchProjectConfig(config).then(
      (r) => ({ kind: "ok" as const, ...r }),
      (error: unknown) => ({ kind: "network" as const, error }),
    ),
    fetchFirestoreProbe(config).then(
      (r) => ({ kind: "ok" as const, ...r }),
      (error: unknown) => ({ kind: "network" as const, error }),
    ),
    fetchPasswordProviderProbe(config).then(
      (r) => ({ kind: "ok" as const, ...r }),
      (error: unknown) => ({ kind: "network" as const, error }),
    ),
  ]);

  if (projectConfigResult.kind === "network") {
    networkUnverified = true;
  } else {
    const authStep = mapProjectConfigProbe(
      projectConfigResult.status,
      projectConfigResult.bodyText,
      config,
      0,
    );
    if (authStep.status === "failed") {
      return { ok: false, verified: true, warnings, code: authStep.code ?? "AUTH_UNREACHABLE", message: authStep.message };
    }
  }

  if (firestoreResult.kind === "network") {
    networkUnverified = true;
  } else {
    const firestoreStep = mapFirestoreProbe(firestoreResult.status, firestoreResult.bodyText, config, 0);
    if (firestoreStep.status === "failed") {
      // A disabled database is a real, fixable project defect — block.
      return { ok: false, verified: true, warnings, code: firestoreStep.code ?? "FIRESTORE_UNREACHABLE", message: firestoreStep.message };
    }
  }

  if (passwordResult.kind === "network") {
    networkUnverified = true;
  } else {
    const passwordStep = mapPasswordProviderProbe(passwordResult.status, passwordResult.bodyText, 0);
    if (passwordStep.status === "failed" && passwordStep.code === "AUTH_PROVIDER_DISABLED") {
      warnings.push(passwordStep.message);
    } else if (passwordStep.status === "failed" && passwordStep.code === "RATE_LIMITED") {
      warnings.push(passwordStep.message);
    }
  }

  if (networkUnverified) {
    const networkErrors = [projectConfigResult, firestoreResult, passwordResult]
      .filter((r) => r.kind === "network")
      .map((r) => (r.kind === "network" ? (r.error instanceof Error ? r.error.message : "network error") : ""))
      .filter(Boolean);
    warnings.push(
      `Live verification could not reach Firebase from the server (${networkErrors.slice(0, 2).join("; ") || "network error"}). ` +
        "The config was saved because its fields are valid and match the Admin SDK project, but run Test connection again once network access is restored.",
    );
    return { ok: true, verified: false, warnings };
  }

  return { ok: true, verified: true, warnings };
}

/** Throws an ApiError carrying the exact upstream reason when saving must be blocked. */
export function assertConfigSaveable(verification: SaveVerification): void {
  if (!verification.ok) {
    const status = verification.code === "ADMIN_NOT_CONFIGURED" ? 503 : 400;
    throw new ApiError(status, verification.code ?? "FIREBASE_CONFIG_REJECTED", verification.message ?? "The Firebase config failed live verification.");
  }
}
