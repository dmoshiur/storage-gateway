import { z } from "zod";

/**
 * Single source of truth for the Firebase Web App configuration shape.
 *
 * This module is intentionally environment-agnostic (no `server-only`, no DOM
 * access): it is imported by the browser (Settings paste-box validation, login
 * page, client SDK init) and by the server (API validation, probes, env sync)
 * so both sides enforce the exact same contract.
 *
 * Complete flow:
 *   Settings paste box → parseFirebaseWebConfigJson() → PUT /api/firebase-config
 *   → Firestore `settings/firebase` → GET /api/firebase-config (public,
 *   cached) → client runtime init → Auth → Firestore. Build-time
 *   NEXT_PUBLIC_FIREBASE_* variables remain the fallback and the production
 *   baseline; any drift between the stored override and the build env is
 *   surfaced as "redeploy required" with a copy-paste env snippet.
 *
 * Security: the Web App config holds public identifiers (apiKey, projectId,
 * …) — never Admin/service-account private keys. `parseFirebaseWebConfigJson`
 * explicitly rejects service-account JSON pasted by mistake. Nothing here
 * logs values; use `maskFirebaseValue` / `maskedFirebaseConfig` for display.
 */

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId: string;
  measurementId?: string;
}

export const REQUIRED_FIREBASE_FIELDS = ["apiKey", "authDomain", "projectId", "appId"] as const;
export type RequiredFirebaseField = (typeof REQUIRED_FIREBASE_FIELDS)[number];

export const OPTIONAL_FIREBASE_FIELDS = ["storageBucket", "messagingSenderId", "measurementId"] as const;
export type OptionalFirebaseField = (typeof OPTIONAL_FIREBASE_FIELDS)[number];

export const KNOWN_FIREBASE_FIELDS = [...REQUIRED_FIREBASE_FIELDS, ...OPTIONAL_FIREBASE_FIELDS] as const;
export type KnownFirebaseField = (typeof KNOWN_FIREBASE_FIELDS)[number];

const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]*[a-z0-9]$/;
const APP_ID_PATTERN = /^1:\d+:web:[0-9a-f]+$/i;
const SENDER_ID_PATTERN = /^\d{6,20}$/;
const MEASUREMENT_ID_PATTERN = /^G-[A-Z0-9]{4,}$/;
const API_KEY_PATTERN = /^AIza[0-9A-Za-z_-]{20,}$/;

const trimmedString = (max: number) => z.string().trim().min(1).max(max);

export const firebaseWebConfigSchema = z
  .object({
    apiKey: trimmedString(200),
    authDomain: trimmedString(253),
    projectId: trimmedString(30),
    storageBucket: trimmedString(253).optional(),
    messagingSenderId: trimmedString(32).optional(),
    appId: trimmedString(200),
    measurementId: trimmedString(32).optional(),
  })
  .strict();

export type FirebaseWebConfigInput = z.infer<typeof firebaseWebConfigSchema>;

export interface FirebaseFieldIssue {
  field: string;
  message: string;
}

export interface ParsedFirebaseWebConfig {
  ok: boolean;
  /** Present only when `ok` is true. */
  config: FirebaseWebConfig | null;
  /** Field-level errors that block saving. */
  errors: FirebaseFieldIssue[];
  /** Non-blocking observations (unknown keys, unusual-but-accepted values). */
  warnings: FirebaseFieldIssue[];
  /** Which known fields were detected with a non-empty value. */
  detected: Record<KnownFirebaseField, boolean>;
}

const emptyDetected = (): Record<KnownFirebaseField, boolean> => ({
  apiKey: false,
  authDomain: false,
  projectId: false,
  storageBucket: false,
  messagingSenderId: false,
  appId: false,
  measurementId: false,
});

function failure(errors: FirebaseFieldIssue[], warnings: FirebaseFieldIssue[] = []): ParsedFirebaseWebConfig {
  return { ok: false, config: null, errors, warnings, detected: emptyDetected() };
}

/** Detects a service-account / Admin SDK key pasted into the Web config box. */
function detectServiceAccountKey(value: Record<string, unknown>): string | null {
  if (value.type === "service_account") {
    return "This looks like a Firebase Admin service-account key (\"type\": \"service_account\"), not a Web App config.";
  }
  if (typeof value.private_key === "string" || typeof value.privateKey === "string") {
    return "This object contains a private key (private_key). Service-account keys must never be pasted here.";
  }
  if (typeof value.client_email === "string" && typeof value.token_uri === "string") {
    return "This looks like a service-account credential (client_email/token_uri), not a Web App config.";
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Validates an already-parsed object as a Firebase Web App config.
 * Pure function — safe to run on every keystroke (debounced by the caller).
 */
export function validateFirebaseWebConfig(value: unknown): ParsedFirebaseWebConfig {
  const record = asRecord(value);
  if (!record) {
    return failure([{ field: "config", message: "The configuration must be a JSON object, not an array or primitive value." }]);
  }

  const serviceAccountError = detectServiceAccountKey(record);
  if (serviceAccountError) {
    return failure([
      {
        field: "config",
        message:
          `${serviceAccountError} Paste the Web App config from Firebase Console → Project settings → General → ` +
          `"Your apps" → Web app (apiKey, authDomain, projectId, appId). Admin credentials stay server-side in Vercel.`,
      },
    ]);
  }

  const errors: FirebaseFieldIssue[] = [];
  const warnings: FirebaseFieldIssue[] = [];
  const detected = emptyDetected();

  const readString = (field: KnownFirebaseField): string | null => {
    const raw = record[field];
    if (raw === undefined || raw === null || raw === "") return null;
    if (typeof raw !== "string") {
      errors.push({ field, message: `"${field}" must be a string.` });
      return null;
    }
    const trimmed = raw.trim();
    if (!trimmed) return null;
    detected[field] = true;
    return trimmed;
  };

  const apiKey = readString("apiKey");
  const authDomain = readString("authDomain");
  const projectId = readString("projectId");
  const storageBucket = readString("storageBucket");
  const messagingSenderId = readString("messagingSenderId");
  const appId = readString("appId");
  const measurementId = readString("measurementId");

  for (const field of REQUIRED_FIREBASE_FIELDS) {
    if (!detected[field]) errors.push({ field, message: `Missing required field "${field}".` });
  }

  if (apiKey && !API_KEY_PATTERN.test(apiKey)) {
    warnings.push({
      field: "apiKey",
      message: "This API key does not look like a Firebase Web API key (expected to start with “AIza”). It will still be tested as-is.",
    });
  }
  if (authDomain) {
    if (!HOSTNAME_PATTERN.test(authDomain)) {
      errors.push({ field: "authDomain", message: "“authDomain” must be a valid hostname (e.g. my-project.firebaseapp.com)." });
    } else if (!/(\.firebaseapp\.com|\.web\.app)$/i.test(authDomain)) {
      warnings.push({ field: "authDomain", message: "Unusual auth domain (expected *.firebaseapp.com or *.web.app). Custom auth domains are accepted." });
    }
  }
  if (projectId) {
    if (projectId.length > 30 || !PROJECT_ID_PATTERN.test(projectId)) {
      errors.push({
        field: "projectId",
        message: "“projectId” must be ≤ 30 characters: lowercase letters, digits, and hyphens, starting with a letter.",
      });
    } else if (projectId.length < 6) {
      warnings.push({ field: "projectId", message: "This project ID is shorter than Firebase usually issues. It will still be tested as-is." });
    }
  }
  if (storageBucket) {
    if (!HOSTNAME_PATTERN.test(storageBucket)) {
      warnings.push({ field: "storageBucket", message: "“storageBucket” does not look like a valid bucket hostname. It will still be saved as-is." });
    } else if (!/(\.appspot\.com|\.firebasestorage\.app)$/i.test(storageBucket)) {
      warnings.push({ field: "storageBucket", message: "Unusual storage bucket (expected *.appspot.com or *.firebasestorage.app). It will still be saved as-is." });
    }
  }
  if (messagingSenderId && !SENDER_ID_PATTERN.test(messagingSenderId)) {
    warnings.push({ field: "messagingSenderId", message: "“messagingSenderId” is usually digits only. It will still be saved as-is." });
  }
  if (appId && !APP_ID_PATTERN.test(appId)) {
    errors.push({ field: "appId", message: "“appId” must look like 1:123456789:web:abcdef123456." });
  }
  if (measurementId && !MEASUREMENT_ID_PATTERN.test(measurementId)) {
    warnings.push({ field: "measurementId", message: "“measurementId” usually looks like G-XXXXXXXX. It will still be saved as-is." });
  }

  for (const key of Object.keys(record)) {
    if (!(KNOWN_FIREBASE_FIELDS as readonly string[]).includes(key)) {
      warnings.push({ field: key, message: `Unknown field "${key}" will be ignored.` });
    }
  }

  if (errors.length > 0 || !apiKey || !authDomain || !projectId || !appId) {
    return { ok: false, config: null, errors, warnings, detected };
  }

  const config: FirebaseWebConfig = { apiKey, authDomain, projectId, appId };
  if (storageBucket) config.storageBucket = storageBucket;
  if (messagingSenderId) config.messagingSenderId = messagingSenderId;
  if (measurementId) config.measurementId = measurementId;
  return { ok: true, config, errors: [], warnings, detected };
}

/**
 * Parses pasted text (raw JSON, or a `const firebaseConfig = {...};` snippet)
 * into a validated Firebase Web App config.
 */
export function parseFirebaseWebConfigJson(raw: string): ParsedFirebaseWebConfig {
  const text = raw.trim();
  if (!text) {
    return failure([{ field: "config", message: "Paste your Firebase Web App config JSON to begin." }]);
  }
  const candidates: string[] = [text];
  // Tolerate `const firebaseConfig = {...};` / `firebaseConfig = {...}` snippets.
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const sliced = text.slice(firstBrace, lastBrace + 1);
    if (sliced !== text) candidates.push(sliced);
  }
  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      return validateFirebaseWebConfig(JSON.parse(candidate) as unknown);
    } catch (error) {
      lastError = error;
    }
  }
  const detail = lastError instanceof Error ? lastError.message : "invalid JSON";
  return failure([
    {
      field: "config",
      message: `This is not valid JSON (${detail}). Paste the complete config object, for example {"apiKey": "…", "authDomain": "…", "projectId": "…", "appId": "…"}.`,
    },
  ]);
}

/* ---------------- display helpers (never reveal full values) ---------------- */

export function maskFirebaseValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 6) return `${trimmed.slice(0, 2)}•••`;
  return `${trimmed.slice(0, 4)}••••${trimmed.slice(-2)}`;
}

export function maskedFirebaseConfig(config: FirebaseWebConfig): Record<KnownFirebaseField, string | null> {
  return {
    apiKey: maskFirebaseValue(config.apiKey),
    authDomain: config.authDomain,
    projectId: config.projectId,
    storageBucket: config.storageBucket ?? null,
    messagingSenderId: config.messagingSenderId ? maskFirebaseValue(config.messagingSenderId) : null,
    appId: maskFirebaseValue(config.appId),
    measurementId: config.measurementId ?? null,
  };
}

/* ---------------- environment mapping (build-time baseline) ---------------- */

export const FIREBASE_ENV_VAR_MAP = {
  apiKey: "NEXT_PUBLIC_FIREBASE_API_KEY",
  authDomain: "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
  projectId: "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  storageBucket: "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET",
  messagingSenderId: "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
  appId: "NEXT_PUBLIC_FIREBASE_APP_ID",
  measurementId: "NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID",
} as const satisfies Record<KnownFirebaseField, string>;

/** Reads the build-time baseline from `NEXT_PUBLIC_FIREBASE_*` variables. */
export function envVarsToFirebaseConfig(env: Record<string, string | undefined>): {
  config: FirebaseWebConfig | null;
  missing: string[];
} {
  const read = (name: string): string => env[name]?.trim() ?? "";
  const apiKey = read(FIREBASE_ENV_VAR_MAP.apiKey);
  const authDomain = read(FIREBASE_ENV_VAR_MAP.authDomain);
  const projectId = read(FIREBASE_ENV_VAR_MAP.projectId);
  const appId = read(FIREBASE_ENV_VAR_MAP.appId);
  const storageBucket = read(FIREBASE_ENV_VAR_MAP.storageBucket) || undefined;
  const messagingSenderId = read(FIREBASE_ENV_VAR_MAP.messagingSenderId) || undefined;
  const measurementId = read(FIREBASE_ENV_VAR_MAP.measurementId) || undefined;

  const missing: string[] = [];
  if (!apiKey) missing.push(FIREBASE_ENV_VAR_MAP.apiKey);
  if (!authDomain) missing.push(FIREBASE_ENV_VAR_MAP.authDomain);
  if (!projectId) missing.push(FIREBASE_ENV_VAR_MAP.projectId);
  if (!appId) missing.push(FIREBASE_ENV_VAR_MAP.appId);

  if (missing.length > 0) return { config: null, missing };
  return { config: { apiKey, authDomain, projectId, appId, ...(storageBucket ? { storageBucket } : {}), ...(messagingSenderId ? { messagingSenderId } : {}), ...(measurementId ? { measurementId } : {}) }, missing: [] };
}

export function firebaseConfigToEnvVars(config: FirebaseWebConfig): Record<string, string> {
  const vars: Record<string, string> = {
    [FIREBASE_ENV_VAR_MAP.apiKey]: config.apiKey,
    [FIREBASE_ENV_VAR_MAP.authDomain]: config.authDomain,
    [FIREBASE_ENV_VAR_MAP.projectId]: config.projectId,
    [FIREBASE_ENV_VAR_MAP.appId]: config.appId,
  };
  if (config.storageBucket) vars[FIREBASE_ENV_VAR_MAP.storageBucket] = config.storageBucket;
  if (config.messagingSenderId) vars[FIREBASE_ENV_VAR_MAP.messagingSenderId] = config.messagingSenderId;
  if (config.measurementId) vars[FIREBASE_ENV_VAR_MAP.measurementId] = config.measurementId;
  return vars;
}

/** Copy-paste snippet for Vercel → Project Settings → Environment Variables. */
export function firebaseConfigEnvSnippet(config: FirebaseWebConfig): string {
  return Object.entries(firebaseConfigToEnvVars(config))
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");
}

/** Identity comparison: true when two configs point at the same Firebase app. */
export function firebaseConfigsEqual(left: FirebaseWebConfig | null, right: FirebaseWebConfig | null): boolean {
  if (!left || !right) return left === right;
  return (
    left.apiKey === right.apiKey &&
    left.authDomain === right.authDomain &&
    left.projectId === right.projectId &&
    left.appId === right.appId &&
    (left.storageBucket ?? "") === (right.storageBucket ?? "") &&
    (left.messagingSenderId ?? "") === (right.messagingSenderId ?? "") &&
    (left.measurementId ?? "") === (right.measurementId ?? "")
  );
}

export const FIREBASE_CONFIG_EXAMPLE = `{
  "apiKey": "AIza…",
  "authDomain": "my-project.firebaseapp.com",
  "projectId": "my-project",
  "storageBucket": "my-project.appspot.com",
  "messagingSenderId": "123456789",
  "appId": "1:123456789:web:abcdef123456",
  "measurementId": "G-XXXXXXXX"
}`;

/**
 * Shape of GET /api/firebase-config. Served publicly because the Web App
 * config holds public identifiers (same values the client bundle already
 * embeds via NEXT_PUBLIC_*); `updatedBy` is only populated for
 * authenticated admins. `envSnippet` mirrors `config` as copy-paste
 * Vercel variables for the redeploy flow.
 */
export interface FirebaseRuntimeStatus {
  configured: boolean;
  source: "stored" | "env" | "none";
  config: FirebaseWebConfig | null;
  projectId: string | null;
  authDomain: string | null;
  missing: string[];
  hasStoredOverride: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
  envDrift: boolean;
  redeployRequired: boolean;
  envSnippet: string | null;
  adminProjectId: string | null;
  adminProjectMatch: boolean | null;
}
