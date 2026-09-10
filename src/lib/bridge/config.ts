import "server-only";

/**
 * Runtime configuration for the embedded Storage Bridge.
 *
 * The bridge runs inside this same Next.js deployment on Vercel (no separate
 * FastAPI host is required), so every value below is read from the Vercel
 * project's environment variables. The names mirror the historical standalone
 * bridge so existing operator runbooks keep working.
 */

export const DEFAULT_BRIDGE_CORS_ORIGINS = ["https://gramunnayan.com", "https://www.gramunnayan.com"];
export const DEFAULT_BRIDGE_MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
export const DEFAULT_BRIDGE_SIGNED_URL_EXPIRY_SECONDS = 3600;

/**
 * Guidance threshold for direct multipart uploads. A Vercel Serverless Function
 * invocation rejects request payloads above ~4.5 MB before application code
 * runs, so integrations must send larger documents through the presigned
 * init → PUT → complete flow, which streams bytes straight to R2.
 */
export const DIRECT_UPLOAD_GUIDANCE_BYTES = 4 * 1024 * 1024;

function envInt(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function envList(name: string, fallback: string[]): string[] {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return [...fallback];
  const values = raw.split(",").map((value) => value.trim().replace(/\/+$/, "")).filter(Boolean);
  return values.length > 0 ? values : [...fallback];
}

/**
 * Hard per-file cap for bridge uploads. `AM_STORAGE_MAX_DOCUMENT_BYTES` is
 * preferred; `AM_STORAGE_MAX_PDF_BYTES` remains accepted for existing
 * deployments. The effective limit is the minimum of this value and the
 * dashboard's `maxPdfSizeBytes` setting so neither surface can widen the other.
 */
export function getBridgeMaxDocumentBytes(): number {
  const legacy = envInt("AM_STORAGE_MAX_PDF_BYTES", DEFAULT_BRIDGE_MAX_DOCUMENT_BYTES);
  return envInt("AM_STORAGE_MAX_DOCUMENT_BYTES", legacy);
}

/** Lifetime of signed document URLs returned to the NGO site (60s–24h). */
export function getBridgeSignedUrlExpirySeconds(): number {
  const raw = envInt("AM_STORAGE_SIGNED_URL_EXPIRY_SECONDS", DEFAULT_BRIDGE_SIGNED_URL_EXPIRY_SECONDS);
  return Math.min(86_400, Math.max(60, raw));
}

/** Browser origins allowed to call the bridge (server-to-server calls are unaffected). */
export function getBridgeCorsOrigins(): string[] {
  return envList("CORS_ORIGINS", DEFAULT_BRIDGE_CORS_ORIGINS);
}

/**
 * Optional comma-separated static keys accepted without a registry round-trip
 * (self-hosted/offline mode). Dashboard-managed keys are always verified
 * against the Firestore registry.
 */
export function getStaticBridgeKeys(): string[] {
  return (process.env.AM_STORAGE_KEYS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/** True when the legacy external-bridge origin points at this same deployment. */
export function bridgeUrlPointsAtRequest(request: Request, bridgeUrl: string): boolean {
  let target: URL;
  try {
    target = new URL(bridgeUrl);
  } catch {
    return false;
  }
  const hostCandidates = [
    request.headers.get("x-forwarded-host"),
    request.headers.get("host"),
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.split(",")[0].trim().toLowerCase());
  try {
    hostCandidates.push(new URL(request.url).host.toLowerCase());
  } catch {
    // request.url is always absolute in Next.js; ignore unexpected shapes.
  }
  return hostCandidates.some((host) => host === target.host.toLowerCase());
}
