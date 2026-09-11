/**
 * Shared Firebase connection-probe contracts and upstream-error mapping.
 *
 * Imported by BOTH the server probe (`@/lib/firebase/probe`, authoritative:
 * also checks the Admin SDK project match) and the browser probe
 * (`@/lib/firebase/client-probe`, proves the operator's browser can reach
 * Firebase through the deployed CSP/network). Keeping the mapping in one
 * place guarantees the Settings UI reports the exact same reason for the
 * exact same upstream failure on both sides.
 *
 * Nothing here logs or persists values — probes only ever send the public
 * Web API key as a query parameter (exactly as the Firebase JS SDK does) and
 * report status codes plus truncated upstream messages.
 */

export type ProbeStepStatus = "passed" | "failed" | "warning" | "skipped";

export interface ProbeStep {
  id: string;
  label: string;
  status: ProbeStepStatus;
  /** Human-readable outcome including the exact upstream reason on failure. */
  message: string;
  latencyMs: number;
  /** Machine-readable code for UI branching (e.g. WRONG_PROJECT). */
  code?: string;
}

export interface ProbeReport {
  ok: boolean;
  status: "connected" | "failed";
  steps: ProbeStep[];
  summary: string;
  checkedAt: string;
  latencyMs: number;
  projectId: string | null;
}

export function summarizeProbe(steps: ProbeStep[], projectId: string | null, startedAt: number): ProbeReport {
  const failed = steps.filter((step) => step.status === "failed");
  const ok = failed.length === 0;
  const checkedAt = new Date().toISOString();
  const latencyMs = Date.now() - startedAt;
  const summary = ok
    ? "Connected: Firebase initialization, Auth, and Firestore all responded for this project."
    : `Failed: ${failed.map((step) => step.message).join(" ")}`.slice(0, 600);
  return { ok, status: ok ? "connected" : "failed", steps, summary, checkedAt, latencyMs, projectId };
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; bodyText: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const bodyText = await response.text().catch(() => "");
    return { status: response.status, bodyText: bodyText.slice(0, 2000) };
  } finally {
    clearTimeout(timer);
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message));
}

interface UpstreamError {
  status: number;
  /** Normalized Identity Toolkit / Firestore error token, e.g. EMAIL_NOT_FOUND. */
  token: string;
  /** Raw upstream message, truncated — safe to surface (no credentials). */
  message: string;
}

export function parseUpstreamError(status: number, bodyText: string): UpstreamError {
  let token = "";
  let message = "";
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: string; status?: string } };
    message = typeof parsed?.error?.message === "string" ? parsed.error.message : "";
    token = typeof parsed?.error?.status === "string" ? parsed.error.status : "";
    if (!token && message) token = message.split(":")[0]?.trim() ?? "";
  } catch {
    message = bodyText.slice(0, 300);
  }
  return { status, token: token.toUpperCase(), message: message.slice(0, 300) };
}

/**
 * Maps `relyingparty/getProjectConfig` (Identity Toolkit) results.
 * A 200 proves the API key is valid AND reveals which project it belongs to,
 * which is how a "wrong project" paste is detected precisely.
 */
export function mapProjectConfigProbe(
  status: number,
  bodyText: string,
  candidateProjectId: string,
  latencyMs: number,
): ProbeStep {
  const base = { id: "auth", label: "Authentication service", latencyMs };
  if (status === 200) {
    let upstreamProjectId = "";
    try {
      upstreamProjectId = (JSON.parse(bodyText) as { projectId?: string }).projectId ?? "";
    } catch {
      upstreamProjectId = "";
    }
    if (upstreamProjectId && upstreamProjectId !== candidateProjectId) {
      return {
        ...base,
        status: "failed",
        code: "WRONG_PROJECT",
        message:
          `Wrong project: this API key belongs to Firebase project “${upstreamProjectId}”, ` +
          `but the pasted config says projectId “${candidateProjectId}”. Paste the Web App config from the same project.`,
      };
    }
    return {
      ...base,
      status: "passed",
      message: `Auth responded for project “${upstreamProjectId || candidateProjectId}” and the API key is valid.`,
    };
  }
  const upstream = parseUpstreamError(status, bodyText);
  if (upstream.token.includes("API_KEY") || upstream.token.includes("API KEY") || upstream.message.toLowerCase().includes("api key not valid")) {
    return { ...base, status: "failed", code: "INVALID_API_KEY", message: `Firebase rejected the API key (upstream ${status}: ${upstream.message || upstream.token || "invalid key"}). Verify NEXT_PUBLIC_FIREBASE_API_KEY / the pasted apiKey.` };
  }
  if (upstream.token.includes("PROJECT_NOT_FOUND") || upstream.token.includes("NOT_FOUND") || status === 404) {
    return { ...base, status: "failed", code: "PROJECT_NOT_FOUND", message: `Firebase project “${candidateProjectId}” was not found (upstream ${status}). Check the projectId and that the project still exists.` };
  }
  if (status === 403 && /suspend|disabled|blocked/i.test(upstream.message)) {
    return { ...base, status: "failed", code: "PROJECT_SUSPENDED", message: `Firebase refused the request (upstream ${status}: ${upstream.message || "project suspended or blocked"}).` };
  }
  return { ...base, status: "failed", code: "AUTH_UNREACHABLE", message: `Auth check failed (upstream ${status}: ${upstream.message || upstream.token || "unexpected response"}).` };
}

/**
 * Maps a `signInWithPassword` probe with a deliberately non-existent user.
 * EMAIL_NOT_FOUND / INVALID_PASSWORD prove the Email/Password provider is
 * enabled; OPERATION_NOT_ALLOWED proves it is disabled. Side-effect free:
 * a failed sign-in creates nothing.
 */
export function mapPasswordProviderProbe(status: number, bodyText: string, latencyMs: number): ProbeStep {
  const base = { id: "auth-password", label: "Email/Password sign-in", latencyMs };
  if (status === 200) {
    // Practically unreachable with a bogus user, but it still proves Auth works.
    return { ...base, status: "passed", message: "Email/Password sign-in responded." };
  }
  const upstream = parseUpstreamError(status, bodyText);
  if (upstream.token.includes("OPERATION_NOT_ALLOWED") || upstream.token.includes("PASSWORD_LOGIN_DISABLED") || upstream.token.includes("ADMIN_ONLY_OPERATION")) {
    return {
      ...base,
      status: "failed",
      code: "AUTH_PROVIDER_DISABLED",
      message:
        "Email/Password sign-in is disabled in this Firebase project (upstream OPERATION_NOT_ALLOWED). " +
        "Enable it in Firebase Console → Authentication → Sign-in method → Email/Password.",
    };
  }
  if (upstream.token.includes("EMAIL_NOT_FOUND") || upstream.token.includes("INVALID_PASSWORD") || upstream.token.includes("INVALID_LOGIN_CREDENTIALS") || upstream.token.includes("INVALID_CREDENTIAL")) {
    return { ...base, status: "passed", message: "Email/Password provider is enabled (probe sign-in correctly rejected an unknown user)." };
  }
  if (upstream.token.includes("TOO_MANY_ATTEMPTS") || status === 429) {
    return { ...base, status: "failed", code: "RATE_LIMITED", message: "Firebase temporarily rate-limited the probe (too many attempts). Wait a minute and test again." };
  }
  if (upstream.token.includes("USER_DISABLED")) {
    return { ...base, status: "passed", message: "Auth responded (probe account state confirms the provider is enabled)." };
  }
  if (upstream.token.includes("API_KEY") || upstream.message.toLowerCase().includes("api key not valid")) {
    return { ...base, status: "failed", code: "INVALID_API_KEY", message: `Firebase rejected the API key (upstream ${status}: ${upstream.message || "invalid key"}).` };
  }
  return { ...base, status: "failed", code: "AUTH_UNREACHABLE", message: `Email/Password probe failed (upstream ${status}: ${upstream.message || upstream.token || "unexpected response"}).` };
}

/**
 * Maps a Firestore REST read of a deliberately non-existent probe document.
 * NOT_FOUND / PERMISSION_DENIED both prove Firestore is enabled and
 * reachable; only the exact reason differs.
 */
export function mapFirestoreProbe(status: number, bodyText: string, projectId: string, latencyMs: number): ProbeStep {
  const base = { id: "firestore", label: "Firestore database", latencyMs };
  if (status === 200) {
    return { ...base, status: "passed", message: "Firestore responded (probe document unexpectedly exists — database is reachable)." };
  }
  const upstream = parseUpstreamError(status, bodyText);
  const combined = `${upstream.token} ${upstream.message}`.toLowerCase();
  if (status === 404 && (upstream.token === "NOT_FOUND" || /requested entity was not found|no document to update/i.test(upstream.message))) {
    return { ...base, status: "passed", message: `Firestore is reachable for project “${projectId}” (probe document correctly not found).` };
  }
  if (status === 403 && (upstream.token === "PERMISSION_DENIED" || /permission/i.test(combined))) {
    if (/has not been used in project|is disabled|enable it by visiting/i.test(upstream.message)) {
      return {
        ...base,
        status: "failed",
        code: "FIRESTORE_DISABLED",
        message: `Cloud Firestore is not enabled in project “${projectId}” (upstream 403: ${upstream.message}). Enable Firestore in Firebase Console.`,
      };
    }
    return { ...base, status: "passed", message: "Firestore is reachable; the unauthenticated probe read was denied by security rules, as expected." };
  }
  if (combined.includes("api key") || upstream.token.includes("API_KEY")) {
    return { ...base, status: "failed", code: "INVALID_API_KEY", message: `Firestore rejected the API key (upstream ${status}: ${upstream.message || "invalid key"}).` };
  }
  if (combined.includes("project_not_found") || (status === 404 && combined.includes("project"))) {
    return { ...base, status: "failed", code: "PROJECT_NOT_FOUND", message: `Firestore project “${projectId}” was not found (upstream ${status}). Check the projectId.` };
  }
  if (status >= 500) {
    return { ...base, status: "failed", code: "FIRESTORE_UNAVAILABLE", message: `Firestore is temporarily unavailable (upstream ${status}: ${upstream.message || upstream.token || "server error"}). Retry shortly.` };
  }
  return { ...base, status: "failed", code: "FIRESTORE_UNREACHABLE", message: `Firestore check failed (upstream ${status}: ${upstream.message || upstream.token || "unexpected response"}).` };
}

export function networkFailureStep(id: string, label: string, error: unknown, latencyMs: number): ProbeStep {
  if (isAbortError(error)) {
    return { id, label, status: "failed", code: "TIMEOUT", latencyMs, message: `${label} timed out — Firebase did not answer in time. Check network connectivity and retry.` };
  }
  const message = error instanceof Error ? error.message : "network error";
  const normalized = /failed to fetch|networkerror|network request failed|econn|enotfound|etimedout/i.test(message)
    ? "Network error contacting Firebase. Check connectivity (and, in the browser, the Content-Security-Policy connect-src list) and try again."
    : `Network error contacting Firebase (${message.slice(0, 160)}).`;
  return { id, label, status: "failed", code: "NETWORK_ERROR", latencyMs, message: `${label}: ${normalized}` };
}
