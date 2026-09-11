import { describe, expect, it } from "vitest";
import {
  envVarsToFirebaseConfig,
  firebaseConfigEnvSnippet,
  firebaseConfigToEnvVars,
  firebaseConfigsEqual,
  maskFirebaseValue,
  parseFirebaseWebConfigJson,
  validateFirebaseWebConfig,
} from "@/lib/firebase/web-config";
import {
  mapFirestoreProbe,
  mapPasswordProviderProbe,
  mapProjectConfigProbe,
  networkFailureStep,
  summarizeProbe,
} from "@/lib/firebase/probe-shared";

const FULL_CONFIG = {
  apiKey: "AIzaSyD-EXAMPLE-KEY-1234567890abcdefgh",
  authDomain: "demo-project.firebaseapp.com",
  projectId: "demo-project",
  storageBucket: "demo-project.appspot.com",
  messagingSenderId: "123456789012",
  appId: "1:123456789012:web:abcdef1234567890",
  measurementId: "G-ABCDEF1234",
};

describe("Firebase web config parsing", () => {
  it("accepts a complete valid config and detects every field", () => {
    const parsed = parseFirebaseWebConfigJson(JSON.stringify(FULL_CONFIG));
    expect(parsed.ok).toBe(true);
    expect(parsed.config).toEqual(FULL_CONFIG);
    expect(parsed.errors).toEqual([]);
    expect(Object.values(parsed.detected).every(Boolean)).toBe(true);
  });

  it("accepts the four required fields alone", () => {
    const { apiKey, authDomain, projectId, appId } = FULL_CONFIG;
    const parsed = parseFirebaseWebConfigJson(JSON.stringify({ apiKey, authDomain, projectId, appId }));
    expect(parsed.ok).toBe(true);
    expect(parsed.config).toMatchObject({ apiKey, authDomain, projectId, appId });
    expect(parsed.detected.storageBucket).toBe(false);
  });

  it("tolerates a const firebaseConfig = {...}; snippet", () => {
    const parsed = parseFirebaseWebConfigJson(`const firebaseConfig = ${JSON.stringify(FULL_CONFIG)};`);
    expect(parsed.ok).toBe(true);
    expect(parsed.config?.projectId).toBe("demo-project");
  });

  it("rejects invalid JSON with guidance", () => {
    const parsed = parseFirebaseWebConfigJson("{ apiKey: oops");
    expect(parsed.ok).toBe(false);
    expect(parsed.errors[0]?.message).toMatch(/not valid JSON/i);
  });

  it("reports every missing required field", () => {
    const parsed = parseFirebaseWebConfigJson(JSON.stringify({ projectId: "demo-project" }));
    expect(parsed.ok).toBe(false);
    const fields = parsed.errors.map((issue) => issue.field).sort();
    expect(fields).toEqual(["apiKey", "appId", "authDomain"]);
  });

  it("rejects non-object payloads", () => {
    expect(parseFirebaseWebConfigJson("[1,2]").ok).toBe(false);
    expect(parseFirebaseWebConfigJson("\"nope\"").ok).toBe(false);
    expect(validateFirebaseWebConfig(null).ok).toBe(false);
  });

  it("rejects Firebase Admin service-account keys with guidance", () => {
    const serviceAccount = {
      type: "service_account",
      project_id: "demo-project",
      private_key: "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n",
      client_email: "x@demo-project.iam.gserviceaccount.com",
    };
    const parsed = parseFirebaseWebConfigJson(JSON.stringify(serviceAccount));
    expect(parsed.ok).toBe(false);
    expect(parsed.errors[0]?.message).toMatch(/service-account/i);
    expect(parsed.errors[0]?.message).toMatch(/must never be pasted here|Admin credentials stay server-side/);
  });

  it("rejects a private_key object even without the service_account type", () => {
    const parsed = validateFirebaseWebConfig({ apiKey: "x", private_key: "secret" });
    expect(parsed.ok).toBe(false);
    expect(parsed.errors[0]?.message).toMatch(/private key/i);
  });

  it("validates field formats", () => {
    const badApp = validateFirebaseWebConfig({ ...FULL_CONFIG, appId: "not-an-app-id" });
    expect(badApp.ok).toBe(false);
    expect(badApp.errors.some((issue) => issue.field === "appId")).toBe(true);

    const badProject = validateFirebaseWebConfig({ ...FULL_CONFIG, projectId: "INVALID_PROJECT!!" });
    expect(badProject.ok).toBe(false);

    const badDomain = validateFirebaseWebConfig({ ...FULL_CONFIG, authDomain: "not a domain" });
    expect(badDomain.ok).toBe(false);
  });

  it("warns on unknown keys without blocking save", () => {
    const parsed = validateFirebaseWebConfig({ ...FULL_CONFIG, databaseURL: "https://x.firebaseio.com" });
    expect(parsed.ok).toBe(true);
    expect(parsed.warnings.some((issue) => issue.field === "databaseURL")).toBe(true);
  });

  it("warns on unusual-but-accepted optional values", () => {
    const parsed = validateFirebaseWebConfig({ ...FULL_CONFIG, apiKey: "not-a-google-key" });
    expect(parsed.ok).toBe(true);
    expect(parsed.warnings.some((issue) => issue.field === "apiKey")).toBe(true);
  });

  it("requires empty-string fields as missing", () => {
    const parsed = validateFirebaseWebConfig({ ...FULL_CONFIG, apiKey: "   " });
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.some((issue) => issue.field === "apiKey")).toBe(true);
  });
});

describe("masking and env mapping", () => {
  it("masks values without ever containing the full secret", () => {
    const masked = maskFirebaseValue(FULL_CONFIG.apiKey);
    expect(FULL_CONFIG.apiKey).not.toContain(masked.replaceAll("•", ""));
    expect(masked).toMatch(/^AIza/);
    expect(masked.length).toBeLessThan(FULL_CONFIG.apiKey.length);
    expect(maskFirebaseValue("short")).toContain("•");
  });

  it("reads the build-time env baseline and reports missing vars", () => {
    const full = envVarsToFirebaseConfig({
      NEXT_PUBLIC_FIREBASE_API_KEY: FULL_CONFIG.apiKey,
      NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: FULL_CONFIG.authDomain,
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: FULL_CONFIG.projectId,
      NEXT_PUBLIC_FIREBASE_APP_ID: FULL_CONFIG.appId,
    });
    expect(full.config?.projectId).toBe("demo-project");
    expect(full.missing).toEqual([]);

    const empty = envVarsToFirebaseConfig({});
    expect(empty.config).toBeNull();
    expect(empty.missing).toContain("NEXT_PUBLIC_FIREBASE_API_KEY");
    expect(empty.missing).toContain("NEXT_PUBLIC_FIREBASE_PROJECT_ID");
  });

  it("generates a Vercel-ready snippet with no private-key material", () => {
    const vars = firebaseConfigToEnvVars(FULL_CONFIG);
    expect(vars.NEXT_PUBLIC_FIREBASE_PROJECT_ID).toBe("demo-project");
    const snippet = firebaseConfigEnvSnippet(FULL_CONFIG);
    expect(snippet).toContain("NEXT_PUBLIC_FIREBASE_API_KEY=");
    expect(snippet).toContain("NEXT_PUBLIC_FIREBASE_APP_ID=");
    expect(snippet).not.toMatch(/PRIVATE KEY|FIREBASE_PRIVATE_KEY|CLIENT_EMAIL/i);
  });

  it("compares configs by identity", () => {
    expect(firebaseConfigsEqual(FULL_CONFIG, { ...FULL_CONFIG })).toBe(true);
    expect(firebaseConfigsEqual(FULL_CONFIG, { ...FULL_CONFIG, projectId: "other" })).toBe(false);
    expect(firebaseConfigsEqual(FULL_CONFIG, null)).toBe(false);
    expect(firebaseConfigsEqual(null, null)).toBe(true);
  });
});

describe("probe error mapping", () => {
  it("passes when the API key's project matches the candidate", () => {
    const step = mapProjectConfigProbe(200, JSON.stringify({ projectId: "demo-project" }), "demo-project", 12);
    expect(step.status).toBe("passed");
  });

  it("detects a wrong-project paste precisely", () => {
    const step = mapProjectConfigProbe(200, JSON.stringify({ projectId: "other-project" }), "demo-project", 12);
    expect(step.status).toBe("failed");
    expect(step.code).toBe("WRONG_PROJECT");
    expect(step.message).toContain("other-project");
    expect(step.message).toContain("demo-project");
  });

  it("maps an invalid API key", () => {
    const body = JSON.stringify({ error: { code: 400, message: "API key not valid. Please pass a valid API key." } });
    const step = mapProjectConfigProbe(400, body, "demo-project", 5);
    expect(step.status).toBe("failed");
    expect(step.code).toBe("INVALID_API_KEY");
  });

  it("treats EMAIL_NOT_FOUND as proof the password provider is enabled", () => {
    const body = JSON.stringify({ error: { message: "EMAIL_NOT_FOUND" } });
    const step = mapPasswordProviderProbe(400, body, 7);
    expect(step.status).toBe("passed");
  });

  it("reports a disabled Email/Password provider with the fix", () => {
    const body = JSON.stringify({ error: { message: "OPERATION_NOT_ALLOWED" } });
    const step = mapPasswordProviderProbe(400, body, 7);
    expect(step.status).toBe("failed");
    expect(step.code).toBe("AUTH_PROVIDER_DISABLED");
    expect(step.message).toMatch(/Enable it in Firebase Console/);
  });

  it("treats NOT_FOUND and PERMISSION_DENIED as Firestore reachable", () => {
    const notFound = mapFirestoreProbe(
      404,
      JSON.stringify({ error: { status: "NOT_FOUND", message: "Requested entity was not found." } }),
      "demo-project",
      9,
    );
    expect(notFound.status).toBe("passed");

    const denied = mapFirestoreProbe(
      403,
      JSON.stringify({ error: { status: "PERMISSION_DENIED", message: "Missing or insufficient permissions." } }),
      "demo-project",
      9,
    );
    expect(denied.status).toBe("passed");
  });

  it("reports Firestore not enabled as a distinct failure", () => {
    const body = JSON.stringify({
      error: { status: "PERMISSION_DENIED", message: "Cloud Firestore API has not been used in project demo-project before or it is disabled." },
    });
    const step = mapFirestoreProbe(403, body, "demo-project", 9);
    expect(step.status).toBe("failed");
    expect(step.code).toBe("FIRESTORE_DISABLED");
  });

  it("maps aborts to timeouts and failures to network errors", () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    expect(networkFailureStep("auth", "Auth", abort, 3).code).toBe("TIMEOUT");
    expect(networkFailureStep("auth", "Auth", new TypeError("Failed to fetch"), 3).code).toBe("NETWORK_ERROR");
  });

  it("summarizes reports with Connected/Failed semantics", () => {
    const ok = summarizeProbe(
      [{ id: "a", label: "A", status: "passed", message: "fine", latencyMs: 1 }],
      "demo-project",
      Date.now(),
    );
    expect(ok.ok).toBe(true);
    expect(ok.status).toBe("connected");

    const bad = summarizeProbe(
      [{ id: "a", label: "A", status: "failed", message: "exact reason here", latencyMs: 1 }],
      "demo-project",
      Date.now(),
    );
    expect(bad.ok).toBe(false);
    expect(bad.status).toBe("failed");
    expect(bad.summary).toContain("exact reason here");
  });
});
