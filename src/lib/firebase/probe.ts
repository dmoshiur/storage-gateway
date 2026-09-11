import "server-only";

import type { FirebaseWebConfig } from "@/lib/firebase/web-config";
import { getAdminProjectId } from "@/lib/firebase/runtime-store";
import {
  fetchWithTimeout,
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
 *   shape validation → Auth (Identity Toolkit) → Email/Password provider →
 *   Firestore → Admin SDK project match.
 *
 * The Admin-match step is what makes "Connected" actually mean "the existing
 * Firebase user can sign in": the browser signs in against the Web config's
 * project, and the server verifies the resulting ID token with the Admin SDK
 * — if those two projects differ, sign-in can never succeed.
 */

const PROBE_TIMEOUT_MS = 9000;
const FIRESTORE_PROBE_DOC = "__gateway_probe__/__ping__";

async function probeProjectConfig(config: FirebaseWebConfig): Promise<ProbeStep> {
  const startedAt = Date.now();
  const url = `https://www.googleapis.com/identitytoolkit/v3/relyingparty/getProjectConfig?key=${encodeURIComponent(config.apiKey)}`;
  try {
    const { status, bodyText } = await fetchWithTimeout(url, { method: "GET", cache: "no-store" }, PROBE_TIMEOUT_MS);
    return mapProjectConfigProbe(status, bodyText, config.projectId, Date.now() - startedAt);
  } catch (error) {
    return networkFailureStep("auth", "Authentication service", error, Date.now() - startedAt);
  }
}

async function probePasswordProvider(config: FirebaseWebConfig): Promise<ProbeStep> {
  const startedAt = Date.now();
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(config.apiKey)}`;
  try {
    const { status, bodyText } = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Deliberately non-existent user: EMAIL_NOT_FOUND proves the provider
        // is enabled; nothing is created or locked by a failed sign-in.
        body: JSON.stringify({
          email: "gateway-config-probe@example.invalid",
          password: "GatewayProbePassword-0-invalid!",
          returnSecureToken: true,
        }),
        cache: "no-store",
      },
      PROBE_TIMEOUT_MS,
    );
    return mapPasswordProviderProbe(status, bodyText, Date.now() - startedAt);
  } catch (error) {
    return networkFailureStep("auth-password", "Email/Password sign-in", error, Date.now() - startedAt);
  }
}

async function probeFirestore(config: FirebaseWebConfig): Promise<ProbeStep> {
  const startedAt = Date.now();
  const url =
    `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}` +
    `/databases/(default)/documents/${FIRESTORE_PROBE_DOC}?key=${encodeURIComponent(config.apiKey)}`;
  try {
    const { status, bodyText } = await fetchWithTimeout(url, { method: "GET", cache: "no-store" }, PROBE_TIMEOUT_MS);
    return mapFirestoreProbe(status, bodyText, config.projectId, Date.now() - startedAt);
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
        "Sign-in tokens from the browser would fail server verification. Update the FIREBASE_* variables in Vercel to the same project and redeploy.",
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
  const [auth, password, firestore] = await Promise.all([
    probeProjectConfig(config),
    probePasswordProvider(config),
    probeFirestore(config),
  ]);
  // Skip the provider detail when Auth itself already failed — one exact
  // reason beats two cascading errors.
  const steps: ProbeStep[] = [
    auth,
    auth.status === "failed" ? { ...password, status: "skipped" as const, message: "Skipped: Authentication service check failed first." } : password,
    firestore,
    probeAdminMatch(config),
  ];
  return summarizeProbe(steps, config.projectId, startedAt);
}
