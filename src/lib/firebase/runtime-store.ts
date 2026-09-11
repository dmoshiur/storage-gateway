import "server-only";

import { readFile, writeFile } from "node:fs/promises";
import { ApiError } from "@/lib/api/errors";
import { logger } from "@/lib/logging/logger";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  envVarsToFirebaseConfig,
  firebaseConfigsEqual,
  FIREBASE_ENV_VAR_MAP,
  firebaseConfigToEnvVars,
  validateFirebaseWebConfig,
  type FirebaseWebConfig,
} from "@/lib/firebase/web-config";

/**
 * Server-side persistence for the Firebase Web App configuration.
 *
 * Production truth lives in Firestore (`settings/firebase`) so it survives
 * redeploys and is visible to every serverless instance immediately after
 * "Save & apply" — no rebuild needed for the running deployment. The
 * build-time NEXT_PUBLIC_FIREBASE_* variables remain the fallback and the
 * baseline that fresh builds boot from; `envDrift`/`redeployRequired` tell
 * the operator when the two disagree.
 *
 * Reads never throw for missing Admin credentials: the public config
 * endpoint degrades to the build-time env baseline so the login page keeps
 * working (and keeps reporting exactly what is missing). Writes require a
 * working Admin SDK because silently persisting nowhere would be a fake save.
 *
 * Never logs values — only field presence, project ids, and drift booleans.
 */

const FIREBASE_SETTINGS_COLLECTION = "settings";
const FIREBASE_SETTINGS_DOCUMENT = "firebase";

interface StoredFirebaseRecord {
  config: FirebaseWebConfig;
  updatedAt: string;
  updatedBy: string;
}

interface CacheEntry {
  record: StoredFirebaseRecord | null;
  expiresAt: number;
}

let cache: CacheEntry | null = null;
const CACHE_TTL_MS = 30_000;

export function invalidateFirebaseRuntimeCache(): void {
  cache = null;
}

function readBuildEnv(): Record<string, string | undefined> {
  return {
    [FIREBASE_ENV_VAR_MAP.apiKey]: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    [FIREBASE_ENV_VAR_MAP.authDomain]: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    [FIREBASE_ENV_VAR_MAP.projectId]: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    [FIREBASE_ENV_VAR_MAP.storageBucket]: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    [FIREBASE_ENV_VAR_MAP.messagingSenderId]: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    [FIREBASE_ENV_VAR_MAP.appId]: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
    [FIREBASE_ENV_VAR_MAP.measurementId]: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
  };
}

export function getBuildFirebaseConfig(): { config: FirebaseWebConfig | null; missing: string[] } {
  return envVarsToFirebaseConfig(readBuildEnv());
}

/** Safe read of the Admin SDK project id — presence only, never throws. */
export function getAdminProjectId(): string | null {
  const value = process.env.FIREBASE_PROJECT_ID?.trim() ?? "";
  return value || null;
}

/** Stored override from Firestore, or null when absent/unreachable. Never throws. */
export async function getStoredFirebaseWebConfig(): Promise<StoredFirebaseRecord | null> {
  if (cache && cache.expiresAt > Date.now()) return cache.record;
  let record: StoredFirebaseRecord | null = null;
  try {
    const snapshot = await getAdminDb().collection(FIREBASE_SETTINGS_COLLECTION).doc(FIREBASE_SETTINGS_DOCUMENT).get();
    const data = snapshot.data() as { config?: unknown; updatedAt?: unknown; updatedBy?: unknown } | undefined;
    if (data?.config) {
      const parsed = validateFirebaseWebConfig(data.config);
      if (parsed.ok && parsed.config) {
        const updatedAt = data.updatedAt instanceof Date
          ? data.updatedAt.toISOString()
          : typeof data.updatedAt === "string"
            ? data.updatedAt
            : null;
        record = {
          config: parsed.config,
          updatedAt: updatedAt ?? new Date(0).toISOString(),
          updatedBy: typeof data.updatedBy === "string" ? data.updatedBy : "unknown",
        };
      } else {
        logger.warn("Stored Firebase web config failed validation; ignoring override", {
          errors: parsed.errors.map((issue) => `${issue.field}:${issue.message}`),
        });
      }
    }
  } catch (error) {
    // Firestore/Admin unavailable (or misconfigured): degrade to build env.
    // This is a normal cold-start state, not a crash — log once at warn.
    logger.warn("Stored Firebase web config unavailable; using build-time env baseline", {
      error: error instanceof Error ? error.message : "unknown",
    });
  }
  cache = { record, expiresAt: Date.now() + CACHE_TTL_MS };
  return record;
}

export interface EffectiveFirebaseWebConfig {
  configured: boolean;
  source: "stored" | "env" | "none";
  config: FirebaseWebConfig | null;
  missing: string[];
  hasStoredOverride: boolean;
  storedUpdatedAt: string | null;
  storedUpdatedBy: string | null;
  /** Stored override differs from the build-time env baseline. */
  envDrift: boolean;
  /** Production builds need the new env vars + a redeploy to match runtime. */
  redeployRequired: boolean;
  adminProjectId: string | null;
  adminProjectMatch: boolean | null;
}

export async function getEffectiveFirebaseWebConfig(): Promise<EffectiveFirebaseWebConfig> {
  const [stored, build] = await Promise.all([getStoredFirebaseWebConfig(), Promise.resolve(getBuildFirebaseConfig())]);
  const adminProjectId = getAdminProjectId();
  const hasStoredOverride = stored !== null;
  const envDrift = hasStoredOverride && build.config !== null && !firebaseConfigsEqual(stored.config, build.config);
  // A stored override that the current build env does not contain (missing
  // vars or different values) needs a Vercel env update + redeploy so the
  // next build boots from the same project without depending on Firestore.
  const redeployRequired = hasStoredOverride && (build.config === null || !firebaseConfigsEqual(stored.config, build.config));

  if (stored) {
    return {
      configured: true,
      source: "stored",
      config: stored.config,
      missing: [],
      hasStoredOverride,
      storedUpdatedAt: stored.updatedAt,
      storedUpdatedBy: stored.updatedBy,
      envDrift,
      redeployRequired,
      adminProjectId,
      adminProjectMatch: adminProjectId ? adminProjectId === stored.config.projectId : null,
    };
  }
  if (build.config) {
    return {
      configured: true,
      source: "env",
      config: build.config,
      missing: [],
      hasStoredOverride: false,
      storedUpdatedAt: null,
      storedUpdatedBy: null,
      envDrift: false,
      redeployRequired: false,
      adminProjectId,
      adminProjectMatch: adminProjectId ? adminProjectId === build.config.projectId : null,
    };
  }
  return {
    configured: false,
    source: "none",
    config: null,
    missing: build.missing,
    hasStoredOverride: false,
    storedUpdatedAt: null,
    storedUpdatedBy: null,
    envDrift: false,
    redeployRequired: false,
    adminProjectId,
    adminProjectMatch: null,
  };
}

export interface DevEnvSyncResult {
  attempted: boolean;
  updated: boolean;
  reason: string;
}

/**
 * Best-effort `.env.local` sync for local development only: keeps the next
 * `npm run dev` / `npm run build` booting from the saved project without
 * manual copy-paste. Never runs in production or on Vercel (read-only /
 * ephemeral filesystem) — there the operator copies the snippet into Vercel
 * env vars and redeploys. Never throws.
 */
async function syncDevEnvFile(config: FirebaseWebConfig): Promise<DevEnvSyncResult> {
  if (process.env.NODE_ENV === "production" || process.env.VERCEL === "1") {
    return { attempted: false, updated: false, reason: "production" };
  }
  try {
    const path = `${process.cwd()}/.env.local`;
    let content = "";
    try {
      content = await readFile(path, "utf8");
    } catch {
      content = "";
    }
    const vars = firebaseConfigToEnvVars(config);
    const lines = content.split("\n");
    const seen = new Set<string>();
    const next = lines.map((line) => {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=/);
      if (match && vars[match[1]!]) {
        seen.add(match[1]!);
        return `${match[1]}=${vars[match[1]!]}`;
      }
      return line;
    });
    for (const [name, value] of Object.entries(vars)) {
      if (!seen.has(name)) next.push(`${name}=${value}`);
    }
    await writeFile(path, `${next.join("\n").trim()}\n`, "utf8");
    return { attempted: true, updated: true, reason: "env-local-updated" };
  } catch (error) {
    return {
      attempted: true,
      updated: false,
      reason: error instanceof Error ? error.message.slice(0, 160) : "write-failed",
    };
  }
}

export async function saveStoredFirebaseWebConfig(
  config: FirebaseWebConfig,
  actorUid: string,
): Promise<{ record: StoredFirebaseRecord; devEnvSync: DevEnvSyncResult }> {
  let db;
  try {
    db = getAdminDb();
  } catch {
    throw new ApiError(
      503,
      "SERVICE_CONFIGURATION_ERROR",
      "Firebase Admin is not configured, so the web config cannot be persisted. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY in Vercel and redeploy, then save again.",
    );
  }
  const updatedAt = new Date().toISOString();
  try {
    await db.collection(FIREBASE_SETTINGS_COLLECTION).doc(FIREBASE_SETTINGS_DOCUMENT).set(
      { config, updatedAt: new Date(updatedAt), updatedBy: actorUid, source: "admin-settings-ui" },
      { merge: true },
    );
  } catch (error) {
    logger.error("Saving Firebase web config failed", { error: error instanceof Error ? error.message : "unknown" });
    throw new ApiError(503, "FIRESTORE_UNAVAILABLE", "Firestore is temporarily unavailable. The configuration was not saved — retry shortly.");
  }
  const record: StoredFirebaseRecord = { config, updatedAt, updatedBy: actorUid };
  cache = { record, expiresAt: Date.now() + CACHE_TTL_MS };
  const devEnvSync = await syncDevEnvFile(config);
  logger.info("Firebase web config saved", {
    actorUid,
    projectId: config.projectId,
    authDomain: config.authDomain,
    devEnvSync: devEnvSync.updated ? "updated" : devEnvSync.reason,
  });
  return { record, devEnvSync };
}

export async function clearStoredFirebaseWebConfig(actorUid: string): Promise<void> {
  try {
    await getAdminDb().collection(FIREBASE_SETTINGS_COLLECTION).doc(FIREBASE_SETTINGS_DOCUMENT).delete();
  } catch (error) {
    logger.error("Resetting Firebase web config failed", { error: error instanceof Error ? error.message : "unknown" });
    throw new ApiError(503, "FIRESTORE_UNAVAILABLE", "Firestore is temporarily unavailable. The stored override was not removed — retry shortly.");
  }
  cache = { record: null, expiresAt: Date.now() + CACHE_TTL_MS };
  logger.info("Firebase web config override cleared", { actorUid });
}
