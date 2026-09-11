import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { describeFailure } from "@/lib/api/failures";
import { describeAdminCredentialIdentity, getAdminDb } from "@/lib/firebase/admin";
import { getEffectiveFirebaseWebConfig } from "@/lib/firebase/runtime-store";
import { getStorageService } from "@/lib/storage";
import { getCleanupStatus } from "@/lib/firestore/cleanup-lock";
import { version as appVersion } from "../../../../../package.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface DatabaseProbe {
  connected: boolean;
  latencyMs: number;
  /** Real Firestore collection the Files page reads. */
  collection: string;
  documentsRead: number | null;
  /** Underlying error code/message when the probe failed — never hidden. */
  error?: string;
  errorCode?: string;
  hint?: string;
}

/**
 * Reads one document from the real `files` collection with the Admin SDK.
 *
 * A failed probe reports the actual Firestore error instead of a bare
 * `connected: false`: a missing composite index, a service account from the
 * wrong project, and a network outage all need different fixes, and none of
 * them can be diagnosed from a boolean.
 */
async function probeDatabase(): Promise<DatabaseProbe> {
  const startedAt = Date.now();
  try {
    const snapshot = await getAdminDb().collection("files").limit(1).get();
    return { connected: true, latencyMs: Date.now() - startedAt, collection: "files", documentsRead: snapshot.size };
  } catch (error) {
    const failure = describeFailure(error, "firestore");
    return {
      connected: false,
      latencyMs: Date.now() - startedAt,
      collection: "files",
      documentsRead: null,
      error: failure.message,
      errorCode: failure.code,
      ...(failure.hint ? { hint: failure.hint } : {}),
    };
  }
}

/** Which Firebase project the Admin SDK is actually talking to. */
function adminProjectId(): string | null {
  return process.env.FIREBASE_PROJECT_ID?.trim() || null;
}

export async function GET(request: Request) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "read_files");
    enforceRateLimit(`system:health:${actor.uid}`, 30);
    const [database, blob, cleanup, firebaseWeb] = await Promise.all([
      probeDatabase(),
      getStorageService().healthCheck(),
      getCleanupStatus().catch(() => null),
      getEffectiveFirebaseWebConfig().catch(() => null),
    ]);
    const firebaseWebStatus = !firebaseWeb || !firebaseWeb.configured
      ? "degraded"
      : firebaseWeb.adminProjectMatch === false
        ? "degraded"
        : "healthy";
    // A service account from a different project than FIREBASE_PROJECT_ID makes
    // every Firestore read fail with PERMISSION_DENIED — report it explicitly.
    const credential = describeAdminCredentialIdentity();
    const credentialMismatch = credential.projectMatch === false;
    const degraded = !database.connected || !blob.reachable || firebaseWebStatus !== "healthy" || credentialMismatch;
    return success({
      status: degraded ? "degraded" : "healthy",
      version: appVersion,
      checkedAt: new Date().toISOString(),
      services: {
        application: { status: "healthy" },
        database: {
          status: database.connected ? "healthy" : "degraded",
          latencyMs: database.latencyMs,
          provider: "cloud-firestore",
          collection: database.collection,
          documentsRead: database.documentsRead,
          // The project the Admin SDK queries — this is the value that must
          // match the Firebase project holding the `files` collection.
          adminProjectId: adminProjectId(),
          // …and the project the service account actually belongs to. A
          // mismatch means every read fails with PERMISSION_DENIED.
          credentialProjectId: credential.credentialProjectId,
          credentialProjectMatch: credential.projectMatch,
          ...(database.error ? { error: database.error } : {}),
          ...(database.errorCode ? { errorCode: database.errorCode } : {}),
          ...(database.hint ? { hint: database.hint } : {}),
        },
        blobStorage: {
          status: blob.reachable ? "healthy" : "degraded",
          latencyMs: blob.latencyMs,
          checkedAt: blob.checkedAt,
          authMode: blob.authMode ?? null,
          ...(blob.error ? { error: blob.error } : {}),
        },
        authentication: { status: "healthy", provider: "firebase-auth" },
        firebaseWeb: {
          status: firebaseWebStatus,
          source: firebaseWeb?.source ?? "none",
          projectId: firebaseWeb?.config?.projectId ?? null,
          redeployRequired: firebaseWeb?.redeployRequired ?? false,
          adminProjectMatch: firebaseWeb?.adminProjectMatch ?? null,
          ...(firebaseWeb && !firebaseWeb.configured ? { missing: firebaseWeb.missing } : {}),
        },
        scheduledCleanup: {
          status: cleanup?.lastError ? "degraded" : "healthy",
          lastRunAt: cleanup?.completedAt ?? null,
          lastSummary: cleanup?.lastSummary ?? null,
          lastError: cleanup?.lastError ?? null,
        },
      },
    }, requestId);
  }, { route: "system/health" });
}
