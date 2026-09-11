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
 *   Settings paste box → parseFirebaseWebConfig() → PUT /api/firebase-config
 *   → Firestore `settings/firebase` → GET /api/firebase-config (public,
 *   cached) → client runtime init → Auth → Firestore. Build-time
 *   NEXT_PUBLIC_FIREBASE_* variables remain the fallback and the production
 *   baseline; any drift between the stored override and the build env is
 *   surfaced as "redeploy required" with a copy-paste env snippet.
 *
 * Security: the Web App config holds public identifiers (apiKey, projectId,
 * …) — never Admin/service-account private keys. `parseFirebaseWebConfig`
 * explicitly rejects service-account keys pasted by mistake. Nothing here
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
    return failure([{ field: "config", message: "The configuration must be an object, not an array or primitive value." }]);
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

/* ---------------- tolerant config parsing (JSON + Firebase JS format) ---------------- */

/**
 * Firebase Console → Project settings → “SDK setup and configuration” hands
 * out the config as a JavaScript object literal — unquoted keys, single or
 * double quotes, trailing commas — which is NOT strict JSON. The parser
 * below accepts both strict JSON and that standard Firebase format and
 * normalizes either one into the same canonical object for validation.
 *
 * Safety: this is a hand-written tokenizer with no `eval`/`Function`
 * execution, so pasted text can never run code. Only flat string-valued
 * objects are accepted; nested objects/arrays/functions are rejected.
 */

class FirebaseConfigSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FirebaseConfigSyntaxError";
  }
}

/**
 * Extracts every top-level balanced `{…}` block from surrounding code (e.g.
 * a full Firebase console snippet with `import { … }` plus
 * `const firebaseConfig = {...}; initializeApp(firebaseConfig);`), honoring
 * strings and comments so braces inside values don't confuse the scan.
 */
function extractBalancedObjects(text: string): string[] {
  const blocks: string[] = [];
  let blockStart = -1;
  let depth = 0;
  let quote: string | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    const next = text[i + 1] as string | undefined;
    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      lineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      blockComment = true;
      i++;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) blockStart = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && blockStart !== -1) {
          blocks.push(text.slice(blockStart, i + 1));
          blockStart = -1;
        }
      }
    }
  }
  return blocks;
}

function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const lines = trimmed.split("\n");
  lines.shift();
  const closing = lines.findIndex((line) => line.trim().startsWith("```"));
  if (closing >= 0) lines.splice(closing);
  return lines.join("\n").trim();
}

/**
 * Parses one flat object literal with Firebase-style tolerance: unquoted or
 * quoted keys, single/double/backtick string values with JS escapes,
 * `//` and `/*…*\/` comments, and trailing commas. Returns a plain record;
 * throws FirebaseConfigSyntaxError with a human-readable reason otherwise.
 */
function parseJsObjectLiteral(source: string): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  let i = 0;

  const syntaxError = (message: string): FirebaseConfigSyntaxError => {
    const context = source.slice(Math.max(0, i - 24), i).replace(/\s+/g, " ").trim();
    return new FirebaseConfigSyntaxError(context ? `${message} (near “…${context}”)` : message);
  };

  const skipTrivia = (): void => {
    while (i < source.length) {
      const ch = source[i] as string;
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v" || ch === "\u00a0" || ch === "\ufeff") {
        i++;
        continue;
      }
      if (ch === "/" && source[i + 1] === "/") {
        i += 2;
        while (i < source.length && source[i] !== "\n") i++;
        continue;
      }
      if (ch === "/" && source[i + 1] === "*") {
        i += 2;
        let closed = false;
        while (i < source.length) {
          if (source[i] === "*" && source[i + 1] === "/") {
            i += 2;
            closed = true;
            break;
          }
          i++;
        }
        if (!closed) throw syntaxError("Unterminated block comment");
        continue;
      }
      break;
    }
  };

  const parseString = (): string => {
    const quote = source[i] as string;
    if (quote !== "'" && quote !== '"' && quote !== "`") throw syntaxError("Expected a string value in quotes");
    i++;
    let out = "";
    while (i < source.length) {
      const ch = source[i] as string;
      if (ch === "\\") {
        const esc = source[i + 1] as string | undefined;
        if (esc === undefined) throw syntaxError("Unterminated string — a value is missing its closing quote");
        switch (esc) {
          case "n": out += "\n"; i += 2; break;
          case "r": out += "\r"; i += 2; break;
          case "t": out += "\t"; i += 2; break;
          case "b": out += "\b"; i += 2; break;
          case "f": out += "\f"; i += 2; break;
          case "v": out += "\v"; i += 2; break;
          case "0": out += "\0"; i += 2; break;
          case "'": out += "'"; i += 2; break;
          case '"': out += '"'; i += 2; break;
          case "`": out += "`"; i += 2; break;
          case "\\": out += "\\"; i += 2; break;
          case "/": out += "/"; i += 2; break;
          case "\n": i += 2; break;
          case "\r":
            i += 2;
            if (source[i] === "\n") i++;
            break;
          case "u": {
            if (source[i + 2] === "{") {
              const end = source.indexOf("}", i + 3);
              const hex = end === -1 ? "" : source.slice(i + 3, end);
              if (end === -1 || !/^[0-9a-fA-F]+$/.test(hex)) throw syntaxError("Invalid unicode escape in a string value");
              out += String.fromCodePoint(parseInt(hex, 16));
              i = end + 1;
            } else {
              const hex = source.slice(i + 2, i + 6);
              if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw syntaxError("Invalid unicode escape in a string value");
              out += String.fromCharCode(parseInt(hex, 16));
              i += 6;
            }
            break;
          }
          case "x": {
            const hex = source.slice(i + 2, i + 4);
            if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw syntaxError("Invalid escape in a string value");
            out += String.fromCharCode(parseInt(hex, 16));
            i += 4;
            break;
          }
          default:
            // Unknown escapes degrade to the literal character (JS semantics).
            out += esc;
            i += 2;
            break;
        }
        continue;
      }
      if (ch === quote) {
        i++;
        return out;
      }
      if ((ch === "\n" || ch === "\r") && quote !== "`") {
        throw syntaxError("Unterminated string — a value is missing its closing quote");
      }
      out += ch;
      i++;
    }
    throw syntaxError("Unterminated string — a value is missing its closing quote");
  };

  const parseKey = (): string => {
    const ch = source[i] as string;
    if (ch === "'" || ch === '"' || ch === "`") return parseString();
    const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(i));
    if (!match) throw syntaxError("Expected a field name");
    i += match[0].length;
    return match[0];
  };

  const parseValue = (): unknown => {
    const ch = source[i] as string;
    if (ch === "'" || ch === '"' || ch === "`") return parseString();
    const rest = source.slice(i);
    const boundary = (token: string): boolean => {
      const after = rest[token.length] as string | undefined;
      return after === undefined || !/[A-Za-z0-9_$]/.test(after);
    };
    if (rest.startsWith("true") && boundary("true")) { i += 4; return true; }
    if (rest.startsWith("false") && boundary("false")) { i += 5; return false; }
    if (rest.startsWith("null") && boundary("null")) { i += 4; return null; }
    if (rest.startsWith("undefined") && boundary("undefined")) { i += 9; return undefined; }
    const numeric = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(rest);
    if (numeric) {
      i += numeric[0].length;
      return Number(numeric[0]);
    }
    if (ch === "{" || ch === "[") {
      throw syntaxError("Nested objects and arrays are not supported — config values must be strings");
    }
    throw syntaxError("Expected a string value in quotes");
  };

  skipTrivia();
  if (source[i] !== "{") throw syntaxError("Expected the config to start with “{”");
  i++;
  skipTrivia();
  if (source[i] === "}") {
    i++;
    skipTrivia();
    if (source[i] === ";") i++;
    skipTrivia();
    if (i !== source.length) throw syntaxError("Unexpected text after the config object");
    return record;
  }
  for (;;) {
    skipTrivia();
    if (i >= source.length) throw syntaxError("Unterminated config — a closing “}” is missing");
    if (source[i] === "}") {
      i++;
      break;
    }
    const key = parseKey();
    skipTrivia();
    if (source[i] !== ":") throw syntaxError(`Expected “:” after field “${key}”`);
    i++;
    skipTrivia();
    if (i >= source.length) throw syntaxError(`Missing value for field “${key}”`);
    record[key] = parseValue();
    skipTrivia();
    if (i >= source.length) throw syntaxError("Unterminated config — a closing “}” is missing");
    if (source[i] === ",") {
      i++;
      continue;
    }
    if (source[i] === "}") {
      i++;
      break;
    }
    throw syntaxError("Expected “,” or “}” between fields");
  }
  skipTrivia();
  if (source[i] === ";") i++;
  skipTrivia();
  if (i !== source.length) throw syntaxError("Unexpected text after the config object");
  return record;
}

/**
 * Parses pasted text into a validated Firebase Web App config.
 *
 * Accepts strict JSON, the standard Firebase JavaScript-object format
 * (unquoted keys, single or double quotes, trailing commas, comments), and
 * full console snippets (`import …`, `const firebaseConfig = {...};`,
 * `initializeApp(firebaseConfig)`) — normalizing all of them into one
 * canonical validated object. Service-account keys are rejected.
 */
export function parseFirebaseWebConfig(raw: string): ParsedFirebaseWebConfig {
  const text = stripMarkdownFences(raw);
  if (!text) {
    return failure([{ field: "config", message: "Paste your Firebase Web App config to begin." }]);
  }
  const candidates: string[] = [text];
  for (const block of extractBalancedObjects(text)) {
    if (block !== text && !candidates.includes(block)) candidates.push(block);
  }
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const sliced = text.slice(firstBrace, lastBrace + 1);
    if (!candidates.includes(sliced)) candidates.push(sliced);
  }
  // Every candidate that parses (strict JSON first, then the standard
  // Firebase JavaScript-object format) is validated; the first fully valid
  // config wins, so surrounding code (`import { … }`, initializers) never
  // shadows the real config block.
  const parsedResults: ParsedFirebaseWebConfig[] = [];
  for (const candidate of candidates) {
    try {
      parsedResults.push(validateFirebaseWebConfig(JSON.parse(candidate) as unknown));
    } catch {
      // Not strict JSON — the JavaScript-object parser tries next.
    }
  }
  let syntaxDetail: string | null = null;
  for (const candidate of candidates) {
    try {
      parsedResults.push(validateFirebaseWebConfig(parseJsObjectLiteral(candidate)));
    } catch (error) {
      if (syntaxDetail === null) {
        syntaxDetail = error instanceof FirebaseConfigSyntaxError ? error.message : "invalid syntax";
      }
    }
  }
  const valid = parsedResults.find((result) => result.ok);
  if (valid) return valid;
  // Something parsed but failed validation: surface the field-level reasons
  // (missing fields, service-account rejection) instead of a syntax error.
  const firstParsed = parsedResults[0];
  if (firstParsed) return firstParsed;
  return failure([
    {
      field: "config",
      message:
        `Could not parse this Firebase config (${syntaxDetail ?? "invalid syntax"}). ` +
        `Paste the complete config object — strict JSON or the standard Firebase format, ` +
        `for example { apiKey: "…", authDomain: "…", projectId: "…", appId: "…" }.`,
    },
  ]);
}

/**
 * Backwards-compatible alias for `parseFirebaseWebConfig` (the previous
 * JSON-only implementation was replaced by the tolerant parser above).
 * @deprecated Use `parseFirebaseWebConfig` instead.
 */
export const parseFirebaseWebConfigJson = parseFirebaseWebConfig;

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
  apiKey: "AIza…",
  authDomain: "my-project.firebaseapp.com",
  projectId: "my-project",
  storageBucket: "my-project.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abcdef123456",
  measurementId: "G-XXXXXXXX"
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
