/**
 * Shared Firebase connection-probe contracts, live probe calls, and
 * upstream-error mapping.
 *
 * Imported by BOTH the server probe (`@/lib/firebase/probe`, authoritative:
 * also checks the Admin SDK project match) and the browser probe
 * (`@/lib/firebase/client-probe`, proves the operator's browser can reach
 * Firebase through the deployed CSP/network). Keeping the calls and mapping
 * in one place guarantees the Settings UI reports the exact same reason for
 * the exact same upstream failure on both sides.
 *
 * CRITICAL project-identity fact (verified against live Firebase projects):
 * the Identity Toolkit `getProjectConfig` endpoint returns the GCP project
 * NUMBER in its `projectId` field — e.g. for project `notes-27f22` the body
 * is `{ "projectId": "424229778181", "authorizedDomains": [...] }`. It must
 * therefore be compared against the number embedded in the pasted appId
 * (`1:<number>:web:<hash>`) / messagingSenderId, NEVER directly against the
 * string projectId — doing so produced false "Wrong project" failures for
 * perfectly valid configs. The string projectId is corroborated separately
 * via the default domains in `authorizedDomains` and the Firestore
 * `CONSUMER_INVALID` cross-project rejection.
 *
 * Nothing here logs or persists values — probes only ever send the public
 * Web API key as a query parameter (exactly as the Firebase JS SDK does) and
 * report status codes plus truncated upstream messages.
 */

import {
  defaultAuthDomainsForProject,
  inspectConfigConsistency,
  projectNumberFromAppId,
  type FirebaseWebConfig,
} from "@/lib/firebase/web-config";

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

/**
 * Firestore probe location. Collection/document ids must NEVER match the
 * reserved pattern `__.*__` (Firestore rejects them with
 * 400 INVALID_ARGUMENT "Collection id ... is invalid because it is reserved"),
 * and must not be `.`/`..` or contain slashes. The probe reads a document
 * that intentionally does not exist: 404 NOT_FOUND or a security-rules 403
 * PERMISSION_DENIED both prove the database is reachable.
 */
export const FIRESTORE_PROBE_COLLECTION = "systemHealth";
export const FIRESTORE_PROBE_DOCUMENT = "gatewayProbe";

export function firestoreProbePath(): string {
  return `${FIRESTORE_PROBE_COLLECTION}/${FIRESTORE_PROBE_DOCUMENT}`;
}

export function summarizeProbe(steps: ProbeStep[], projectId: string | null, startedAt: number): ProbeReport {
  const failed = steps.filter((step) => step.status === "failed");
  const warnings = steps.filter((step) => step.status === "warning");
  const ok = failed.length === 0;
  const checkedAt = new Date().toISOString();
  const latencyMs = Date.now() - startedAt;
  const summary = ok
    ? warnings.length === 0
      ? "Connected: Firebase initialization, Auth, and Firestore all responded for this project."
      : `Connected with ${warnings.length} warning${warnings.length === 1 ? "" : "s"}: ${warnings.map((step) => step.message).join(" ")}`.slice(0, 600)
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
    return { status: response.status, bodyText: bodyText.slice(0, 4000) };
  } finally {
    clearTimeout(timer);
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message));
}

interface StructuredError {
  status: number;
  /** Normalized Identity Toolkit / Firestore error token, e.g. EMAIL_NOT_FOUND. */
  token: string;
  /** Raw upstream message, truncated — safe to surface (no credentials). */
  message: string;
  /** google.rpc.ErrorInfo reason, e.g. API_KEY_INVALID / CONSUMER_INVALID. */
  reason: string;
}

export function parseUpstreamError(status: number, bodyText: string): StructuredError {
  let token = "";
  let message = "";
  let reason = "";
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: {
        message?: string;
        status?: string;
        details?: Array<{ reason?: string; metadata?: Record<string, unknown> }>;
      };
    };
    message = typeof parsed?.error?.message === "string" ? parsed.error.message : "";
    token = typeof parsed?.error?.status === "string" ? parsed.error.status : "";
    if (!token && message) token = message.split(":")[0]?.trim() ?? "";
    reason =
      parsed?.error?.details?.find((detail) => detail && typeof detail.reason === "string")?.reason ?? "";
  } catch {
    message = bodyText.slice(0, 300);
  }
  return { status, token: token.toUpperCase(), message: message.slice(0, 400), reason };
}

/* ---------------- live probe calls (isomorphic: browser + Node 20) ---------------- */

export const PROBE_TIMEOUT_MS = 9000;

export function projectConfigUrl(config: FirebaseWebConfig): string {
  return `https://www.googleapis.com/identitytoolkit/v3/relyingparty/getProjectConfig?key=${encodeURIComponent(config.apiKey)}`;
}

export function passwordProviderUrl(config: FirebaseWebConfig): string {
  return `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(config.apiKey)}`;
}

export function firestoreProbeUrl(config: FirebaseWebConfig): string {
  return (
    `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}` +
    `/databases/(default)/documents/${firestoreProbePath()}?key=${encodeURIComponent(config.apiKey)}`
  );
}

/** getProjectConfig — proves the API key is valid and reveals its project NUMBER. */
export async function fetchProjectConfig(
  config: FirebaseWebConfig,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<{ status: number; bodyText: string }> {
  return fetchWithTimeout(projectConfigUrl(config), { method: "GET", cache: "no-store" }, timeoutMs);
}

/** signInWithPassword with a bogus user — proves the Email/Password provider is enabled. */
export async function fetchPasswordProviderProbe(
  config: FirebaseWebConfig,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<{ status: number; bodyText: string }> {
  return fetchWithTimeout(
    passwordProviderUrl(config),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Deliberately non-existent user: EMAIL_NOT_FOUND / INVALID_LOGIN_CREDENTIALS
      // prove the provider is enabled; a failed sign-in creates nothing.
      body: JSON.stringify({
        email: "gateway-config-probe@example.invalid",
        password: "GatewayProbePassword-0-invalid!",
        returnSecureToken: true,
      }),
      cache: "no-store",
    },
    timeoutMs,
  );
}

/** Reads a non-existent, non-reserved probe document over the Firestore REST API. */
export async function fetchFirestoreProbe(
  config: FirebaseWebConfig,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<{ status: number; bodyText: string }> {
  return fetchWithTimeout(firestoreProbeUrl(config), { method: "GET", cache: "no-store" }, timeoutMs);
}

/* ---------------- Auth / project-identity mapping ---------------- */

export interface ProjectConfigInfo {
  /**
   * Raw `projectId` field. On every current Firebase project this is the
   * numeric GCP project NUMBER; legacy projects may return the string id.
   */
  identity: string | null;
  /** True when `identity` is a numeric project number. */
  isProjectNumber: boolean;
  authorizedDomains: string[];
}

export function parseProjectConfigBody(bodyText: string): ProjectConfigInfo {
  try {
    const parsed = JSON.parse(bodyText) as { projectId?: unknown; authorizedDomains?: unknown };
    const identity = typeof parsed.projectId === "string" && parsed.projectId.trim() ? parsed.projectId.trim() : null;
    const authorizedDomains = Array.isArray(parsed.authorizedDomains)
      ? parsed.authorizedDomains.filter((domain): domain is string => typeof domain === "string").map((domain) => domain.toLowerCase())
      : [];
    return { identity, isProjectNumber: Boolean(identity && /^\d{5,}$/.test(identity)), authorizedDomains };
  } catch {
    return { identity: null, isProjectNumber: false, authorizedDomains: [] };
  }
}

/**
 * Local network-free preflight: appId number ↔ messagingSenderId number and
 * the default auth domain ↔ projectId. A paste assembled from two projects
 * fails here before any network call.
 */
export function mapConfigConsistencyStep(
  config: FirebaseWebConfig,
  latencyMs = 0,
  id: string,
  label: string,
): ProbeStep {
  const consistency = inspectConfigConsistency(config);
  if (!consistency.projectNumbersAgree) {
    return {
      id,
      label,
      status: "failed",
      code: "CONFIG_INCONSISTENT",
      latencyMs,
      message:
        `The pasted fields come from different Firebase projects: messagingSenderId is project number ` +
        `${consistency.senderProjectNumber} but appId belongs to project number ${consistency.appIdProjectNumber}. ` +
        `Paste the complete Web App config object from one project — apiKey, authDomain, projectId, ` +
        `messagingSenderId and appId together.`,
    };
  }
  if (consistency.authDomainMatchesProject === false) {
    return {
      id,
      label,
      status: "failed",
      code: "CONFIG_INCONSISTENT",
      latencyMs,
      message:
        `authDomain “${config.authDomain}” is a default Firebase domain of a different project than projectId ` +
        `“${config.projectId}”. The matching domain is “${config.projectId}.firebaseapp.com” (or “.web.app”).`,
    };
  }
  return {
    id,
    label,
    status: "passed",
    latencyMs,
    message: consistency.appIdProjectNumber
      ? `Config fields are internally consistent (project number ${consistency.appIdProjectNumber}).`
      : "Config fields are internally consistent.",
  };
}

/**
 * Maps `relyingparty/getProjectConfig` results.
 *
 * A 200 proves the API key is valid and reveals which project it belongs to.
 * Because the response field is the project NUMBER, it is compared against
 * the number embedded in the candidate appId (and messagingSenderId). The
 * string projectId is then corroborated through the project's default
 * domains in `authorizedDomains`; the Firestore probe adds a second,
 * independent string-id check (CONSUMER_INVALID).
 */
export function mapProjectConfigProbe(
  status: number,
  bodyText: string,
  candidate: FirebaseWebConfig,
  latencyMs: number,
  id = "auth",
  label = "Authentication service",
): ProbeStep {
  const base = { id, label, latencyMs };
  if (status === 200) {
    const info = parseProjectConfigBody(bodyText);
    const expectedNumber = projectNumberFromAppId(candidate.appId);
    const senderNumber = candidate.messagingSenderId?.trim() || null;

    if (!info.identity) {
      return {
        ...base,
        status: "warning",
        code: "AUTH_AMBIGUOUS",
        message:
          "Auth responded but did not identify the owning project; the API key was accepted. " +
          "The Firestore and Admin project-match steps below still verify the project.",
      };
    }

    if (info.isProjectNumber) {
      const upstreamNumber = info.identity;
      // Definitive identity check: the API key's project number must equal
      // the project number in the pasted appId / messagingSenderId.
      if (expectedNumber && upstreamNumber !== expectedNumber) {
        return {
          ...base,
          status: "failed",
          code: "WRONG_PROJECT",
          message:
            `Wrong project: this API key belongs to Firebase project number ${upstreamNumber}` +
            (info.authorizedDomains.find((d) => d.endsWith(".firebaseapp.com"))
              ? ` (“${info.authorizedDomains.find((d) => d.endsWith(".firebaseapp.com"))!.replace(/\.firebaseapp\.com$/, "")}”)`
              : "") +
            `, but the pasted appId ${`1:${expectedNumber}:web:…`} belongs to project number ${expectedNumber}` +
            ` (config projectId “${candidate.projectId}”${senderNumber ? `, senderId ${senderNumber}` : ""}). ` +
            `apiKey, authDomain, projectId, messagingSenderId and appId must all come from the SAME Web App. ` +
            `In Firebase Console for project “${candidate.projectId}”, open Project settings → General → Your apps → Web app and copy that config.`,
        };
      }
      if (senderNumber && /^\d+$/.test(senderNumber) && senderNumber !== upstreamNumber) {
        return {
          ...base,
          status: "failed",
          code: "WRONG_PROJECT",
          message:
            `Wrong project: this API key belongs to Firebase project number ${upstreamNumber}, but the pasted ` +
            `messagingSenderId is ${senderNumber}. All fields must come from the same Web App in project “${candidate.projectId}”.`,
        };
      }

      // Corroborate the STRING project id: the default Hosting domains for
      // the claimed project id should be authorized for this API key's project.
      const defaultDomains = defaultAuthDomainsForProject(candidate.projectId).map((d) => d.toLowerCase());
      const defaultDomainMatch = defaultDomains.find((domain) => info.authorizedDomains.includes(domain));
      const authDomainListed = info.authorizedDomains.includes(candidate.authDomain.toLowerCase());
      if (defaultDomainMatch || authDomainListed) {
        return {
          ...base,
          status: "passed",
          message:
            `Auth responded for project “${candidate.projectId}” (project number ${upstreamNumber}): the API key ` +
            `and appId belong to this project and “${defaultDomainMatch ?? candidate.authDomain}” is authorized.`,
        };
      }
      return {
        ...base,
        status: "warning",
        code: "PROJECT_ID_UNCORROBORATED",
        message:
          `The API key and appId both resolve to project number ${upstreamNumber}, but Auth did not list the ` +
          `default domains “${defaultDomains.join("” / “")}” for projectId “${candidate.projectId}”. ` +
          `The Firestore step independently checks the project id; if it reports WRONG_PROJECT, the pasted ` +
          `projectId/authDomain belong to a different project.`,
      };
    }

    // Legacy projects (or a future API change) may return the string id.
    if (info.identity !== candidate.projectId) {
      return {
        ...base,
        status: "failed",
        code: "WRONG_PROJECT",
        message:
          `Wrong project: this API key belongs to Firebase project “${info.identity}”, but the pasted config ` +
          `says projectId “${candidate.projectId}”. Paste the Web App config from the same project.`,
      };
    }
    return {
      ...base,
      status: "passed",
      message: `Auth responded for project “${candidate.projectId}” and the API key is valid.`,
    };
  }

  const upstream = parseUpstreamError(status, bodyText);
  const combined = `${upstream.token} ${upstream.reason} ${upstream.message}`.toLowerCase();
  if (
    upstream.reason === "API_KEY_INVALID" ||
    upstream.token.includes("API_KEY") ||
    upstream.token.includes("API KEY") ||
    combined.includes("api key not valid")
  ) {
    return {
      ...base,
      status: "failed",
      code: "INVALID_API_KEY",
      message: `Firebase rejected the API key (upstream ${status}: ${upstream.message || upstream.token || "invalid key"}). Verify the apiKey was copied from the Web App config of project “${candidate.projectId}”.`,
    };
  }
  if (upstream.token.includes("PROJECT_NOT_FOUND") || upstream.token.includes("NOT_FOUND") || status === 404) {
    return {
      ...base,
      status: "failed",
      code: "PROJECT_NOT_FOUND",
      message: `Firebase project “${candidate.projectId}” was not found (upstream ${status}). Check the projectId and that the project still exists.`,
    };
  }
  if (status === 403 && /suspend|disabled|blocked/i.test(upstream.message)) {
    return { ...base, status: "failed", code: "PROJECT_SUSPENDED", message: `Firebase refused the request (upstream ${status}: ${upstream.message || "project suspended or blocked"}).` };
  }
  return { ...base, status: "failed", code: "AUTH_UNREACHABLE", message: `Auth check failed (upstream ${status}: ${upstream.message || upstream.token || "unexpected response"}).` };
}

/**
 * Maps a `signInWithPassword` probe with a deliberately non-existent user.
 * EMAIL_NOT_FOUND / INVALID_PASSWORD / INVALID_LOGIN_CREDENTIALS prove the
 * Email/Password provider is enabled; OPERATION_NOT_ALLOWED proves it is
 * disabled. Side-effect free: a failed sign-in creates nothing.
 */
export function mapPasswordProviderProbe(status: number, bodyText: string, latencyMs: number): ProbeStep {
  const base = { id: "auth-password", label: "Email/Password sign-in", latencyMs };
  if (status === 200) {
    // Practically unreachable with a bogus user, but it still proves Auth works.
    return { ...base, status: "passed", message: "Email/Password sign-in responded." };
  }
  const upstream = parseUpstreamError(status, bodyText);
  const combined = `${upstream.token} ${upstream.reason} ${upstream.message}`.toLowerCase();
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
  if (upstream.reason === "API_KEY_INVALID" || upstream.token.includes("API_KEY") || combined.includes("api key not valid")) {
    return { ...base, status: "failed", code: "INVALID_API_KEY", message: `Firebase rejected the API key (upstream ${status}: ${upstream.message || "invalid key"}).` };
  }
  return { ...base, status: "failed", code: "AUTH_UNREACHABLE", message: `Email/Password probe failed (upstream ${status}: ${upstream.message || upstream.token || "unexpected response"}).` };
}

/* ---------------- production authorized-domain check ---------------- */

/**
 * Browser-only: checks the page's current hostname against the project's
 * authorized Auth domains (returned by getProjectConfig). A missing
 * production domain is exactly what causes `auth/unauthorized-domain` at
 * sign-in. Returns null outside a browser or when no domains are known.
 */
export function mapAuthorizedDomainStep(
  candidate: FirebaseWebConfig,
  authorizedDomains: string[],
  hostname: string | null,
  latencyMs: number,
  id: string,
  label: string,
): ProbeStep | null {
  if (!hostname || authorizedDomains.length === 0) return null;
  const base = { id, label, latencyMs };
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  const domains = authorizedDomains.map((domain) => domain.toLowerCase());
  // localhost is always present by default; compare hostnames and ignore port.
  const hostOnly = normalized.split(":")[0]!;
  const authorized =
    domains.includes(hostOnly) ||
    (hostOnly === "127.0.0.1" && domains.includes("localhost"));
  if (authorized) {
    return {
      ...base,
      status: "passed",
      message: `This browser's domain “${hostOnly}” is authorized for Firebase Authentication on project “${candidate.projectId}”.`,
    };
  }
  return {
    ...base,
    status: "warning",
    code: "AUTH_DOMAIN_UNAUTHORIZED",
    message:
      `“${hostOnly}” is not in Firebase Console → Authentication → Settings → Authorized domains for project ` +
      `“${candidate.projectId}”. Real sign-in from this domain would fail with auth/unauthorized-domain. ` +
      `Add this exact domain there (the default ${candidate.projectId}.firebaseapp.com domain is already authorized).`,
  };
}

/* ---------------- Firestore mapping ---------------- */

/**
 * Maps a Firestore REST read of a deliberately non-existent, non-reserved
 * probe document. NOT_FOUND / a security-rules PERMISSION_DENIED both prove
 * Firestore is enabled and reachable; CONSUMER_INVALID proves the API key
 * belongs to a DIFFERENT project than the URL's projectId; and a reserved-id
 * INVALID_ARGUMENT is a defect in our own probe path.
 */
export function mapFirestoreProbe(
  status: number,
  bodyText: string,
  candidate: FirebaseWebConfig,
  latencyMs: number,
  id = "firestore",
  label = "Firestore database",
): ProbeStep {
  const base = { id, label, latencyMs };
  const projectId = candidate.projectId;
  if (status === 200) {
    return { ...base, status: "passed", message: "Firestore responded (probe document unexpectedly exists — database is reachable)." };
  }
  const upstream = parseUpstreamError(status, bodyText);
  const combined = `${upstream.token} ${upstream.reason} ${upstream.message}`.toLowerCase();

  // Our probe path must never trip this; if it does, it is a code defect.
  if (status === 400 && /reserved|invalid because/i.test(combined)) {
    return {
      ...base,
      status: "failed",
      code: "FIRESTORE_RESERVED_ID",
      message: `The probe used a reserved Firestore id (upstream 400: ${upstream.message}). Firestore reserves ids matching __.*__; use ${firestoreProbePath()}.`,
    };
  }
  // Definitive cross-project evidence: the API key's project differs from
  // the projectId in the request path.
  if (
    (status === 403 && upstream.reason === "CONSUMER_INVALID") ||
    /permission denied on resource project/i.test(upstream.message)
  ) {
    return {
      ...base,
      status: "failed",
      code: "WRONG_PROJECT",
      message:
        `Firestore rejected the request as cross-project (upstream 403 CONSUMER_INVALID: “${upstream.message}”). ` +
        `The API key does not belong to project “${projectId}”. Paste the Web App config whose apiKey was ` +
        `created inside project “${projectId}”.`,
    };
  }
  if (status === 404 && (upstream.token === "NOT_FOUND" || /requested entity was not found|no document to update|document .* not found/i.test(upstream.message))) {
    return { ...base, status: "passed", message: `Firestore is reachable for project “${projectId}” (probe document correctly not found).` };
  }
  if (status === 403 && (upstream.token === "PERMISSION_DENIED" || /permission/i.test(combined))) {
    if (/has not been used in project|is disabled|enable it by visiting/i.test(upstream.message)) {
      // The message may name the offending project NUMBER — cross-check it.
      const namedNumber = /project\s+(\d[\d]{4,})/i.exec(upstream.message)?.[1] ?? null;
      const expectedNumber = projectNumberFromAppId(candidate.appId);
      if (namedNumber && expectedNumber && namedNumber !== expectedNumber) {
        return {
          ...base,
          status: "failed",
          code: "WRONG_PROJECT",
          message:
            `The API key routes to project number ${namedNumber}, not the pasted project's number ${expectedNumber} ` +
            `(project “${projectId}”). The apiKey and projectId/appId came from different projects.`,
        };
      }
      return {
        ...base,
        status: "failed",
        code: "FIRESTORE_DISABLED",
        message: `Cloud Firestore is not enabled in project “${projectId}” (upstream 403: ${upstream.message}). Enable Firestore in Firebase Console.`,
      };
    }
    return { ...base, status: "passed", message: "Firestore is reachable; the unauthenticated probe read was denied by security rules, as expected." };
  }
  if (upstream.reason === "API_KEY_INVALID" || combined.includes("api key not valid") || upstream.token.includes("API_KEY")) {
    return { ...base, status: "failed", code: "INVALID_API_KEY", message: `Firestore rejected the API key (upstream ${status}: ${upstream.message || "invalid key"}).` };
  }
  if (combined.includes("project_not_found") || (status === 404 && combined.includes("project"))) {
    return { ...base, status: "failed", code: "PROJECT_NOT_FOUND", message: `Firebase project “${projectId}” was not found (upstream ${status}). Check the projectId.` };
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
  const normalized = /failed to fetch|networkerror|network request failed|econn|enotfound|etimedout|socket disconnected/i.test(message)
    ? "Network error contacting Firebase. Check connectivity (and, in the browser, the Content-Security-Policy connect-src list) and try again."
    : `Network error contacting Firebase (${message.slice(0, 160)}).`;
  return { id, label, status: "failed", code: "NETWORK_ERROR", latencyMs, message: `${label}: ${normalized}` };
}
