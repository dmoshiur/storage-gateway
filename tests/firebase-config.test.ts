import { describe, expect, it } from "vitest";
import {
  envVarsToFirebaseConfig,
  firebaseConfigEnvSnippet,
  firebaseConfigToEnvVars,
  firebaseConfigsEqual,
  maskFirebaseValue,
  parseFirebaseWebConfig,
  parseFirebaseWebConfigJson,
  validateFirebaseWebConfig,
} from "@/lib/firebase/web-config";
import {
  FIRESTORE_PROBE_COLLECTION,
  FIRESTORE_PROBE_DOCUMENT,
  firestoreProbePath,
  mapAuthorizedDomainStep,
  mapConfigConsistencyStep,
  mapFirestoreProbe,
  mapPasswordProviderProbe,
  mapProjectConfigProbe,
  networkFailureStep,
  parseProjectConfigBody,
  summarizeProbe,
} from "@/lib/firebase/probe-shared";
import {
  inspectConfigConsistency,
  projectNumberFromAppId,
} from "@/lib/firebase/web-config";

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

  it("rejects unparseable text with guidance", () => {
    const parsed = parseFirebaseWebConfigJson("{ apiKey: oops");
    expect(parsed.ok).toBe(false);
    expect(parsed.errors[0]?.message).toMatch(/could not parse/i);
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

describe("Firebase web config: standard JS-object format", () => {
  const JS_CONFIG = `{
  apiKey: "AIzaSyD-EXAMPLE-KEY-1234567890abcdefgh",
  authDomain: "demo-project.firebaseapp.com",
  projectId: "demo-project",
  storageBucket: "demo-project.appspot.com",
  messagingSenderId: "123456789012",
  appId: "1:123456789012:web:abcdef1234567890",
  measurementId: "G-ABCDEF1234"
}`;

  it("accepts the exact Firebase Console format (unquoted keys, double quotes)", () => {
    const parsed = parseFirebaseWebConfig(JS_CONFIG);
    expect(parsed.ok).toBe(true);
    expect(parsed.config).toEqual(FULL_CONFIG);
    expect(parsed.errors).toEqual([]);
    expect(Object.values(parsed.detected).every(Boolean)).toBe(true);
  });

  it("normalizes JSON and JS syntax to the identical canonical object", () => {
    const fromJson = parseFirebaseWebConfig(JSON.stringify(FULL_CONFIG));
    const fromJs = parseFirebaseWebConfig(JS_CONFIG);
    expect(fromJson.ok).toBe(true);
    expect(fromJs.ok).toBe(true);
    expect(fromJs.config).toEqual(fromJson.config);
  });

  it("accepts single-quoted string values", () => {
    const parsed = parseFirebaseWebConfig(`{
  apiKey: 'AIzaSyD-EXAMPLE-KEY-1234567890abcdefgh',
  authDomain: 'demo-project.firebaseapp.com',
  projectId: 'demo-project',
  appId: '1:123456789012:web:abcdef1234567890'
}`);
    expect(parsed.ok).toBe(true);
    expect(parsed.config?.projectId).toBe("demo-project");
    expect(parsed.errors).toEqual([]);
  });

  it("accepts quoted keys mixed with unquoted keys", () => {
    const parsed = parseFirebaseWebConfig(`{
  "apiKey": "AIzaSyD-EXAMPLE-KEY-1234567890abcdefgh",
  'authDomain': 'demo-project.firebaseapp.com',
  projectId: "demo-project",
  appId: "1:123456789012:web:abcdef1234567890",
}`);
    expect(parsed.ok).toBe(true);
    expect(parsed.config).toMatchObject({ projectId: "demo-project" });
  });

  it("accepts trailing commas and comments", () => {
    const parsed = parseFirebaseWebConfig(`{
  // Your web app's Firebase configuration
  apiKey: "AIzaSyD-EXAMPLE-KEY-1234567890abcdefgh", // public web key
  /* multi-line
     comment */
  authDomain: "demo-project.firebaseapp.com",
  projectId: "demo-project",
  appId: "1:123456789012:web:abcdef1234567890", // trailing comma below
}`);
    expect(parsed.ok).toBe(true);
    expect(parsed.errors).toEqual([]);
    expect(parsed.config?.appId).toBe("1:123456789012:web:abcdef1234567890");
  });

  it("accepts a const firebaseConfig snippet with surrounding code", () => {
    const parsed = parseFirebaseWebConfig(
      `const firebaseConfig = ${JS_CONFIG};\nconst app = initializeApp(firebaseConfig);`,
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.config?.projectId).toBe("demo-project");
  });

  it("accepts a complete Firebase console snippet including imports", () => {
    const parsed = parseFirebaseWebConfig(
      `// Import the functions you need from the SDKs you need\n` +
        `import { initializeApp } from "firebase/app";\n` +
        `// Your web app's Firebase configuration\n` +
        `const firebaseConfig = {\n` +
        `  apiKey: 'AIzaSyD-EXAMPLE-KEY-1234567890abcdefgh',\n` +
        `  authDomain: 'demo-project.firebaseapp.com',\n` +
        `  projectId: 'demo-project',\n` +
        `  storageBucket: 'demo-project.appspot.com',\n` +
        `  messagingSenderId: '123456789012',\n` +
        `  appId: '1:123456789012:web:abcdef1234567890',\n` +
        `  measurementId: 'G-ABCDEF1234',\n` +
        `};\n\n// Initialize Firebase\nconst app = initializeApp(firebaseConfig);`,
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.config).toEqual(FULL_CONFIG);
    expect(parsed.errors).toEqual([]);
  });

  it("never reports required-field errors when the fields exist", () => {
    const parsed = parseFirebaseWebConfig(JS_CONFIG);
    expect(parsed.ok).toBe(true);
    const requiredErrors = parsed.errors.filter((issue) =>
      ["apiKey", "authDomain", "projectId", "appId"].includes(issue.field),
    );
    expect(requiredErrors).toEqual([]);
  });

  it("still reports genuinely missing required fields in JS syntax", () => {
    const parsed = parseFirebaseWebConfig(`{ projectId: "demo-project" }`);
    expect(parsed.ok).toBe(false);
    const fields = parsed.errors.map((issue) => issue.field).sort();
    expect(fields).toEqual(["apiKey", "appId", "authDomain"]);
  });

  it("rejects service-account keys pasted in JS syntax", () => {
    const parsed = parseFirebaseWebConfig(`{
  type: "service_account",
  project_id: "demo-project",
  private_key: "-----BEGIN PRIVATE KEY-----\\nsecret\\n-----END PRIVATE KEY-----\\n",
  client_email: "x@demo-project.iam.gserviceaccount.com"
}`);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors[0]?.message).toMatch(/service-account/i);
  });

  it("rejects unquoted string values with an actionable message", () => {
    const parsed = parseFirebaseWebConfig("{ apiKey: AIzaNotQuoted, projectId: \"demo-project\" }");
    expect(parsed.ok).toBe(false);
    expect(parsed.errors[0]?.message).toMatch(/could not parse/i);
  });

  it("rejects unterminated configs with an actionable message", () => {
    const parsed = parseFirebaseWebConfig('{ apiKey: "abc", projectId: "demo-project"');
    expect(parsed.ok).toBe(false);
    expect(parsed.errors[0]?.message).toMatch(/closing|unterminated/i);
  });

  it("rejects nested objects and code execution attempts", () => {
    expect(parseFirebaseWebConfig("{ apiKey: { nested: true } }").ok).toBe(false);
    // Function calls / expressions must never be executed or accepted.
    expect(parseFirebaseWebConfig("{ apiKey: process.env.KEY }").ok).toBe(false);
    expect(parseFirebaseWebConfig("while(true){}").ok).toBe(false);
  });

  it("keeps the legacy parseFirebaseWebConfigJson alias working", () => {
    const parsed = parseFirebaseWebConfigJson(JS_CONFIG);
    expect(parsed.ok).toBe(true);
    expect(parsed.config?.projectId).toBe("demo-project");
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

describe("project-number extraction and local consistency", () => {
  it("extracts the project number from a web/iOS/Android appId", () => {
    expect(projectNumberFromAppId("1:123456789012:web:abcdef")).toBe("123456789012");
    expect(projectNumberFromAppId("1:561595434199:ios:abcdef")).toBe("561595434199");
    expect(projectNumberFromAppId("not-an-app-id")).toBeNull();
    expect(projectNumberFromAppId(null)).toBeNull();
  });

  it("accepts matching appId number and messagingSenderId", () => {
    const result = inspectConfigConsistency({
      appId: "1:123456789012:web:abc",
      messagingSenderId: "123456789012",
      authDomain: "demo-project.firebaseapp.com",
      projectId: "demo-project",
    });
    expect(result.projectNumbersAgree).toBe(true);
    expect(result.authDomainMatchesProject).toBe(true);
  });

  it("flags a messagingSenderId from a different project", () => {
    const parsed = validateFirebaseWebConfig({
      ...FULL_CONFIG,
      messagingSenderId: "999999999999",
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.some((issue) => issue.field === "messagingSenderId")).toBe(true);
    expect(parsed.errors[0]?.message).toMatch(/different Firebase projects/);
  });

  it("flags a default authDomain that belongs to another project", () => {
    const parsed = validateFirebaseWebConfig({
      ...FULL_CONFIG,
      authDomain: "other-project.firebaseapp.com",
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.some((issue) => issue.field === "authDomain")).toBe(true);
    expect(parsed.errors[0]?.message).toContain("demo-project.firebaseapp.com");
  });

  it("accepts custom (non-default) auth domains without a local verdict", () => {
    const result = inspectConfigConsistency({
      appId: "1:123456789012:web:abc",
      messagingSenderId: "123456789012",
      authDomain: "login.example.org",
      projectId: "demo-project",
    });
    expect(result.authDomainMatchesProject).toBeNull();
  });

  it("maps an inconsistent config to a failed preflight step", () => {
    const step = mapConfigConsistencyStep(
      { ...FULL_CONFIG, messagingSenderId: "999999999999" },
      2,
      "config-consistency",
      "Config identity",
    );
    expect(step.status).toBe("failed");
    expect(step.code).toBe("CONFIG_INCONSISTENT");
  });
});

describe("probe error mapping", () => {
  // getProjectConfig returns the project NUMBER, so the mapper compares it
  // against the number embedded in appId — not against the string projectId.
  const candidate = {
    apiKey: "AIzaSyD-EXAMPLE-KEY-1234567890abcdefgh",
    authDomain: "demo-project.firebaseapp.com",
    projectId: "demo-project",
    messagingSenderId: "123456789012",
    appId: "1:123456789012:web:abcdef1234567890",
  } satisfies import("@/lib/firebase/web-config").FirebaseWebConfig;

  it("passes when the API key's project NUMBER matches the appId number and default domains", () => {
    const body = JSON.stringify({
      projectId: "123456789012",
      authorizedDomains: ["localhost", "demo-project.firebaseapp.com", "demo-project.web.app"],
    });
    const step = mapProjectConfigProbe(200, body, candidate, 12);
    expect(step.status).toBe("passed");
    expect(step.message).toContain("demo-project");
    expect(step.message).toContain("123456789012");
  });

  it("does NOT flag a valid config when getProjectConfig returns the project number", () => {
    // Regression for the production false-positive: number 561595434199 for
    // project am-st-b507f was wrongly compared to the string projectId.
    const production = {
      apiKey: "AIza...",
      authDomain: "am-st-b507f.firebaseapp.com",
      projectId: "am-st-b507f",
      messagingSenderId: "561595434199",
      appId: "1:561595434199:web:aabbccdd11223344",
    };
    const body = JSON.stringify({
      projectId: "561595434199",
      authorizedDomains: ["localhost", "am-st-b507f.firebaseapp.com", "am-st-b507f.web.app"],
    });
    const step = mapProjectConfigProbe(200, body, production, 9);
    expect(step.status).toBe("passed");
    expect(step.code).toBeUndefined();
  });

  it("detects a genuine wrong-project paste via mismatched project numbers", () => {
    // API key belongs to number 424229778181 (notes-27f22), appId claims 123456789012.
    const body = JSON.stringify({
      projectId: "424229778181",
      authorizedDomains: ["localhost", "notes-27f22.firebaseapp.com", "notes-27f22.web.app"],
    });
    const step = mapProjectConfigProbe(200, body, candidate, 12);
    expect(step.status).toBe("failed");
    expect(step.code).toBe("WRONG_PROJECT");
    expect(step.message).toContain("424229778181");
    expect(step.message).toContain("123456789012");
  });

  it("still supports legacy projects whose endpoint returns the string project id", () => {
    const match = mapProjectConfigProbe(200, JSON.stringify({ projectId: "demo-project" }), candidate, 4);
    expect(match.status).toBe("passed");
    const mismatch = mapProjectConfigProbe(200, JSON.stringify({ projectId: "other-project" }), candidate, 4);
    expect(mismatch.status).toBe("failed");
    expect(mismatch.code).toBe("WRONG_PROJECT");
    expect(mismatch.message).toContain("other-project");
  });

  it("parses the real getProjectConfig shape (project number + authorized domains)", () => {
    const info = parseProjectConfigBody(JSON.stringify({
      projectId: "424229778181",
      authorizedDomains: ["localhost", "Notes-27f22.firebaseapp.com", "notes-27f22.web.app"],
    }));
    expect(info.isProjectNumber).toBe(true);
    expect(info.identity).toBe("424229778181");
    expect(info.authorizedDomains).toContain("notes-27f22.firebaseapp.com");
  });

  it("maps an invalid API key from status and ErrorInfo reason", () => {
    const body = JSON.stringify({
      error: {
        code: 400,
        message: "API key not valid. Please pass a valid API key.",
        status: "INVALID_ARGUMENT",
        details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }],
      },
    });
    const step = mapProjectConfigProbe(400, body, candidate, 5);
    expect(step.status).toBe("failed");
    expect(step.code).toBe("INVALID_API_KEY");
  });

  it("treats EMAIL_NOT_FOUND as proof the password provider is enabled", () => {
    const body = JSON.stringify({ error: { message: "EMAIL_NOT_FOUND" } });
    const step = mapPasswordProviderProbe(400, body, 7);
    expect(step.status).toBe("passed");
  });

  it("accepts INVALID_LOGIN_CREDENTIALS (newer projects) as proof the provider is enabled", () => {
    const body = JSON.stringify({ error: { message: "INVALID_LOGIN_CREDENTIALS" } });
    expect(mapPasswordProviderProbe(400, body, 7).status).toBe("passed");
  });

  it("reports a disabled Email/Password provider with the fix", () => {
    const body = JSON.stringify({ error: { message: "OPERATION_NOT_ALLOWED" } });
    const step = mapPasswordProviderProbe(400, body, 7);
    expect(step.status).toBe("failed");
    expect(step.code).toBe("AUTH_PROVIDER_DISABLED");
    expect(step.message).toMatch(/Enable it in Firebase Console/);
  });

  it("uses a non-reserved Firestore probe path", () => {
    const path = firestoreProbePath();
    expect(path).toBe(`${FIRESTORE_PROBE_COLLECTION}/${FIRESTORE_PROBE_DOCUMENT}`);
    // Firestore reserves ids matching __.*__ and the names "." / "..".
    for (const segment of path.split("/")) {
      expect(segment).not.toMatch(/__/);
      expect(segment).not.toBe(".");
      expect(segment).not.toBe("..");
      expect(segment.length).toBeLessThanOrEqual(1536);
    }
  });

  it("treats NOT_FOUND and security-rules PERMISSION_DENIED as Firestore reachable", () => {
    const notFound = mapFirestoreProbe(
      404,
      JSON.stringify({ error: { status: "NOT_FOUND", message: "Requested entity was not found." } }),
      candidate,
      9,
    );
    expect(notFound.status).toBe("passed");

    const denied = mapFirestoreProbe(
      403,
      JSON.stringify({ error: { status: "PERMISSION_DENIED", message: "Missing or insufficient permissions." } }),
      candidate,
      9,
    );
    expect(denied.status).toBe("passed");
  });

  it("maps the REAL reserved-collection response as a probe defect (regression guard)", () => {
    // Captured live: GET .../documents/__gateway_probe__/__ping__
    const body = JSON.stringify({
      error: { code: 400, message: 'Collection id "__gateway_probe__" is invalid because it is reserved.', status: "INVALID_ARGUMENT" },
    });
    const step = mapFirestoreProbe(400, body, candidate, 6);
    expect(step.status).toBe("failed");
    expect(step.code).toBe("FIRESTORE_RESERVED_ID");
    expect(step.message).toContain(firestoreProbePath());
  });

  it("maps the REAL cross-project CONSUMER_INVALID response as WRONG_PROJECT", () => {
    // Captured live: valid key from one project used against a different projectId path.
    const body = JSON.stringify({
      error: {
        code: 403,
        message: "Permission denied on resource project some-other-project-xyz.",
        status: "PERMISSION_DENIED",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "CONSUMER_INVALID",
            domain: "googleapis.com",
            metadata: { consumer: "projects/some-other-project-xyz", service: "firestore.googleapis.com" },
          },
        ],
      },
    });
    const step = mapFirestoreProbe(403, body, candidate, 8);
    expect(step.status).toBe("failed");
    expect(step.code).toBe("WRONG_PROJECT");
  });

  it("reports Firestore not enabled as a distinct failure", () => {
    const body = JSON.stringify({
      error: { status: "PERMISSION_DENIED", message: "Cloud Firestore API has not been used in project 123456789012 before or it is disabled." },
    });
    const step = mapFirestoreProbe(403, body, candidate, 9);
    expect(step.status).toBe("failed");
    expect(step.code).toBe("FIRESTORE_DISABLED");
  });

  it("treats a 'not used in project N' message naming a different number as WRONG_PROJECT", () => {
    const body = JSON.stringify({
      error: { status: "PERMISSION_DENIED", message: "Cloud Firestore API has not been used in project 424229778181 before or it is disabled." },
    });
    const step = mapFirestoreProbe(403, body, candidate, 9);
    expect(step.status).toBe("failed");
    expect(step.code).toBe("WRONG_PROJECT");
  });

  it("checks the browser hostname against authorized domains", () => {
    const domains = ["localhost", "demo-project.firebaseapp.com", "demo-project.web.app", "app.example.org"];
    const allowed = mapAuthorizedDomainStep(candidate, domains, "app.example.org", 1, "domain", "Domain");
    expect(allowed?.status).toBe("passed");
    const denied = mapAuthorizedDomainStep(candidate, domains, "evil.example.net", 1, "domain", "Domain");
    expect(denied?.status).toBe("warning");
    expect(denied?.code).toBe("AUTH_DOMAIN_UNAUTHORIZED");
    expect(mapAuthorizedDomainStep(candidate, domains, null, 1, "domain", "Domain")).toBeNull();
  });

  it("maps aborts to timeouts and failures to network errors", () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    expect(networkFailureStep("auth", "Auth", abort, 3).code).toBe("TIMEOUT");
    expect(networkFailureStep("auth", "Auth", new TypeError("Failed to fetch"), 3).code).toBe("NETWORK_ERROR");
  });

  it("summarizes reports with Connected/Failed semantics and warns without failing", () => {
    const ok = summarizeProbe(
      [{ id: "a", label: "A", status: "passed", message: "fine", latencyMs: 1 }],
      "demo-project",
      Date.now(),
    );
    expect(ok.ok).toBe(true);
    expect(ok.status).toBe("connected");

    const warned = summarizeProbe(
      [
        { id: "a", label: "A", status: "passed", message: "fine", latencyMs: 1 },
        { id: "b", label: "B", status: "warning", message: "add this domain", latencyMs: 1 },
      ],
      "demo-project",
      Date.now(),
    );
    expect(warned.ok).toBe(true);
    expect(warned.summary).toContain("warning");

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
