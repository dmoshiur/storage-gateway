import { z } from "zod";
import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { parseJson } from "@/lib/api/body";
import { ApiError } from "@/lib/api/errors";
import { requireAdminRequest, getClientIp } from "@/lib/security/request-auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { can } from "@/lib/auth/authorization";
import { SESSION_COOKIE_NAME, verifySessionCookie } from "@/lib/auth/session";
import {
  clearStoredFirebaseWebConfig,
  getEffectiveFirebaseWebConfig,
  saveStoredFirebaseWebConfig,
  type EffectiveFirebaseWebConfig,
} from "@/lib/firebase/runtime-store";
import {
  firebaseConfigEnvSnippet,
  firebaseWebConfigSchema,
  validateFirebaseWebConfig,
  type FirebaseRuntimeStatus,
  type FirebaseWebConfig,
} from "@/lib/firebase/web-config";
import { verifyConfigForSave, assertConfigSaveable, type SaveVerification } from "@/lib/firebase/probe";
import { writeAuditLogSafely, auditActorFrom } from "@/lib/firestore/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const saveSchema = z.object({ config: firebaseWebConfigSchema });

function toRuntimeStatus(effective: EffectiveFirebaseWebConfig, includeUpdatedBy: boolean): FirebaseRuntimeStatus {
  const config: FirebaseWebConfig | null = effective.config;
  return {
    configured: effective.configured,
    source: effective.source,
    config,
    projectId: config?.projectId ?? null,
    authDomain: config?.authDomain ?? null,
    missing: effective.missing,
    hasStoredOverride: effective.hasStoredOverride,
    updatedAt: effective.storedUpdatedAt,
    updatedBy: includeUpdatedBy ? effective.storedUpdatedBy : null,
    envDrift: effective.envDrift,
    redeployRequired: effective.redeployRequired,
    envSnippet: config ? firebaseConfigEnvSnippet(config) : null,
    adminProjectId: effective.adminProjectId,
    adminProjectMatch: effective.adminProjectMatch,
  };
}

/** Best-effort admin check: public callers simply get `updatedBy: null`. */
async function isSettingsAdmin(request: Request): Promise<boolean> {
  try {
    const cookie = request.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^;]+)`))?.[1];
    const actor = await verifySessionCookie(cookie);
    return can(actor.role, "manage_settings");
  } catch {
    return false;
  }
}

/**
 * Public effective-config endpoint (the Web App config holds public
 * identifiers — the same values the client bundle already embeds). The login
 * page and the Firebase runtime boot from here, so it never requires auth
 * and never 503s: when nothing is configured it reports exactly what is
 * missing instead.
 */
export async function GET(request: Request) {
  return apiRoute(request, async (requestId) => {
    enforceRateLimit(`firebase-config:get:${getClientIp(request)}`, 60);
    const [effective, admin] = await Promise.all([getEffectiveFirebaseWebConfig(), isSettingsAdmin(request)]);
    return success(toRuntimeStatus(effective, admin), requestId);
  }, { route: "firebase-config/get" });
}

export async function PUT(request: Request) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "manage_settings", true);
    enforceRateLimit(`firebase-config:save:${actor.uid}`, 20);
    const { config } = await parseJson(request, saveSchema, 8 * 1024);
    // Defense in depth: zod already enforced shape; reject empty-after-trim.
    if (!config.apiKey.trim() || !config.authDomain.trim() || !config.projectId.trim() || !config.appId.trim()) {
      throw new ApiError(400, "VALIDATION_ERROR", "apiKey, authDomain, projectId, and appId are required.");
    }
    // Cross-field validation zod cannot express: appId number ↔
    // messagingSenderId number and default authDomain ↔ projectId.
    const crossField = validateFirebaseWebConfig(config);
    if (!crossField.ok) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        `The pasted config is internally inconsistent — all fields must come from the same Web App: ${crossField.errors
          .map((issue) => issue.message)
          .join(" ")}`,
      );
    }
    // LIVE identity verification before anything is persisted: the API key
    // must actually belong to the same Firebase project as appId/projectId,
    // Firestore must accept the key for that project, and the server Admin
    // SDK must verify that same project. Definitive mismatches block the
    // save; network outages allow it but return verified:false honestly.
    const verification: SaveVerification = await verifyConfigForSave(config);
    assertConfigSaveable(verification);
    const { devEnvSync } = await saveStoredFirebaseWebConfig(config, actor.uid);
    const effective = await getEffectiveFirebaseWebConfig();
    await writeAuditLogSafely({
      action: "SETTINGS_CHANGE",
      actor: auditActorFrom(actor),
      details: {
        area: "firebase-config",
        operation: "save",
        projectId: config.projectId,
        authDomain: config.authDomain,
        source: "stored",
        redeployRequired: effective.redeployRequired,
        devEnvUpdated: devEnvSync.updated,
        liveVerified: verification.verified,
        verificationWarningCount: verification.warnings.length,
      },
    });
    return success({
      status: toRuntimeStatus(effective, true),
      devEnvSync: { updated: devEnvSync.updated, reason: devEnvSync.reason },
      verification: {
        verified: verification.verified,
        warnings: verification.warnings,
      },
    }, requestId);
  }, { route: "firebase-config/save" });
}

export async function DELETE(request: Request) {
  return apiRoute(request, async (requestId) => {
    const actor = await requireAdminRequest(request, "manage_settings", true);
    enforceRateLimit(`firebase-config:reset:${actor.uid}`, 20);
    await clearStoredFirebaseWebConfig(actor.uid);
    const effective = await getEffectiveFirebaseWebConfig();
    await writeAuditLogSafely({
      action: "SETTINGS_CHANGE",
      actor: auditActorFrom(actor),
      details: { area: "firebase-config", operation: "reset", source: effective.source },
    });
    return success({ status: toRuntimeStatus(effective, true) }, requestId);
  }, { route: "firebase-config/reset" });
}
