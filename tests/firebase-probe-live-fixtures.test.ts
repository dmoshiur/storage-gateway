import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * End-to-end probe verification using REAL Firebase upstream responses.
 *
 * The payloads below were captured from live Firebase projects on 2026-09-11
 * (via unauthenticated REST calls — the exact calls the probe itself makes):
 *
 *   Project notes-27f22 (public web app; project number 424229778181):
 *     GET identitytoolkit/v3/relyingparty/getProjectConfig?key=AIza…BYbzY
 *       → 200 { "projectId": "424229778181", "authorizedDomains": […] }
 *         NOTE: the field named projectId carries the PROJECT NUMBER.
 *     GET firestore/v1/projects/notes-27f22/.../systemHealth/gatewayProbe?key=…
 *       → 403 PERMISSION_DENIED "Missing or insufficient permissions." (rules deny anon = reachable)
 *     GET firestore/v1/projects/some-other-project-xyz/…?key=<notes key>
 *       → 403 PERMISSION_DENIED reason CONSUMER_INVALID
 *         "Permission denied on resource project some-other-project-xyz."
 *     GET firestore/v1/projects/notes-27f22/.../__gateway_probe__/__ping__?key=…
 *       → 400 INVALID_ARGUMENT 'Collection id "__gateway_probe__" is invalid because it is reserved.'
 *
 * The production report from the field stated that the valid key for project
 * am-st-b507f resolves to project number 561595434199; the matching Web App
 * appId/messagingSenderId therefore carry 561595434199.
 *
 * globalThis.fetch is stubbed with these captured payloads so the REAL probe
 * pipeline (probeFirebaseWebConfigServer) executes end to end — nothing is
 * mocked at the assertion layer.
 */

const NOTES_CONFIG = {
  apiKey: "AIzaSyBvbTQcsL1DoipWlO0ckApzkwCZgxBYbzY",
  authDomain: "notes-27f22.firebaseapp.com",
  projectId: "notes-27f22",
  messagingSenderId: "424229778181",
  appId: "1:424229778181:web:fa531219ed165346fa7d6c",
};

const PRODUCTION_CONFIG = {
  apiKey: "AIza...redacted-but-valid-in-production...",
  authDomain: "am-st-b507f.firebaseapp.com",
  projectId: "am-st-b507f",
  messagingSenderId: "561595434199",
  appId: "1:561595434199:web:a1b2c3d4e5f60718",
};

const notesProjectConfigBody = JSON.stringify({
  projectId: "424229778181",
  authorizedDomains: [
    "localhost",
    "notes-27f22.firebaseapp.com",
    "notes-27f22.web.app",
    "infinitecampus.xyz",
  ],
});

const productionProjectConfigBody = JSON.stringify({
  projectId: "561595434199",
  authorizedDomains: ["localhost", "am-st-b507f.firebaseapp.com", "am-st-b507f.web.app"],
});

const rulesDeniedBody = JSON.stringify({
  error: { code: 403, message: "Missing or insufficient permissions.", status: "PERMISSION_DENIED" },
});

const consumerInvalidBody = JSON.stringify({
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

const reservedBody = JSON.stringify({
  error: {
    code: 400,
    message: 'Collection id "__gateway_probe__" is invalid because it is reserved.',
    status: "INVALID_ARGUMENT",
  },
});

// Representative provider-enabled response (newer projects return
// INVALID_LOGIN_CREDENTIALS; older ones EMAIL_NOT_FOUND — both are mapped).
const providerEnabledBody = JSON.stringify({
  error: { code: 400, message: "EMAIL_NOT_FOUND", status: "EMAIL_NOT_FOUND" },
});

type StubRule = (url: string) => { status: number; body: string };

function installFetchStub(rule: StubRule) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const { status, body } = rule(url);
    return new Response(body, { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

afterEach(() => {
  delete process.env.FIREBASE_PROJECT_ID;
});

describe("server probe against real captured Firebase responses", () => {
  it("passes the FULL probe for the real notes-27f22 project (number 424229778181)", async () => {
    process.env.FIREBASE_PROJECT_ID = "notes-27f22";
    const { probeFirebaseWebConfigServer } = await import("@/lib/firebase/probe");
    const restore = installFetchStub((url) => {
      if (url.includes("getProjectConfig")) return { status: 200, body: notesProjectConfigBody };
      if (url.includes("signInWithPassword")) return { status: 400, body: providerEnabledBody };
      if (url.includes("/firestore.googleapis.com/")) return { status: 403, body: rulesDeniedBody };
      throw new Error(`unexpected probe URL: ${url}`);
    });
    try {
      const report = await probeFirebaseWebConfigServer(NOTES_CONFIG);
      const byId = Object.fromEntries(report.steps.map((step) => [step.id, step]));
      expect(byId["auth"]?.status).toBe("passed");
      expect(byId["auth-password"]?.status).toBe("passed");
      expect(byId["firestore"]?.status).toBe("passed");
      expect(byId["admin-match"]?.status).toBe("passed");
      expect(byId["config-consistency"]?.status).toBe("passed");
      expect(report.ok).toBe(true);
    } finally {
      restore();
    }
  });

  it("passes the production-shaped am-st-b507f config (the reported false-positive)", async () => {
    process.env.FIREBASE_PROJECT_ID = "am-st-b507f";
    const { probeFirebaseWebConfigServer } = await import("@/lib/firebase/probe");
    const restore = installFetchStub((url) => {
      if (url.includes("getProjectConfig")) return { status: 200, body: productionProjectConfigBody };
      if (url.includes("signInWithPassword")) return { status: 400, body: providerEnabledBody };
      if (url.includes("/firestore.googleapis.com/")) return { status: 403, body: rulesDeniedBody };
      throw new Error(`unexpected probe URL: ${url}`);
    });
    try {
      const report = await probeFirebaseWebConfigServer(PRODUCTION_CONFIG);
      const failed = report.steps.filter((step) => step.status === "failed");
      expect(failed).toEqual([]);
      expect(report.ok).toBe(true);
      // The probe must recognize the NUMBER identity, never reintroduce the
      // string-vs-number comparison that reported the false WRONG_PROJECT.
      expect(report.steps.find((s) => s.code === "WRONG_PROJECT")).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("FAILS WRONG_PROJECT when the key is used against another project id (CONSUMER_INVALID)", async () => {
    process.env.FIREBASE_PROJECT_ID = "some-other-project-xyz";
    const { probeFirebaseWebConfigServer } = await import("@/lib/firebase/probe");
    const mismatchedConfig = {
      ...NOTES_CONFIG,
      projectId: "some-other-project-xyz",
      authDomain: "some-other-project-xyz.firebaseapp.com",
    };
    const restore = installFetchStub((url) => {
      if (url.includes("getProjectConfig")) return { status: 200, body: notesProjectConfigBody };
      if (url.includes("signInWithPassword")) return { status: 400, body: providerEnabledBody };
      if (url.includes("/firestore.googleapis.com/")) return { status: 403, body: consumerInvalidBody };
      throw new Error(`unexpected probe URL: ${url}`);
    });
    try {
      const report = await probeFirebaseWebConfigServer(mismatchedConfig);
      expect(report.ok).toBe(false);
      const codes = report.steps.filter((s) => s.status === "failed").map((s) => s.code);
      expect(codes).toContain("WRONG_PROJECT");
    } finally {
      restore();
    }
  });

  it("FAILS when the API key number disagrees with the appId number even if domains match", async () => {
    process.env.FIREBASE_PROJECT_ID = "am-st-b507f";
    const { probeFirebaseWebConfigServer } = await import("@/lib/firebase/probe");
    // Key belongs to notes-27f22 (424229778181) while appId says am-st (561595434199).
    const frankenstein = {
      ...PRODUCTION_CONFIG,
      apiKey: NOTES_CONFIG.apiKey,
    };
    const restore = installFetchStub((url) => {
      if (url.includes("getProjectConfig")) return { status: 200, body: notesProjectConfigBody };
      if (url.includes("signInWithPassword")) return { status: 400, body: providerEnabledBody };
      return { status: 403, body: consumerInvalidBody };
    });
    try {
      const report = await probeFirebaseWebConfigServer(frankenstein);
      expect(report.ok).toBe(false);
      expect(report.steps.some((s) => s.code === "WRONG_PROJECT")).toBe(true);
    } finally {
      restore();
    }
  });

  it("FAILS when the probe document path is reserved (regression guard for __gateway_probe__)", async () => {
    const { mapFirestoreProbe, firestoreProbePath } = await import("@/lib/firebase/probe-shared");
    expect(firestoreProbePath()).not.toContain("__");
    const step = mapFirestoreProbe(400, reservedBody, NOTES_CONFIG, 4);
    expect(step.status).toBe("failed");
    expect(step.code).toBe("FIRESTORE_RESERVED_ID");
  });

  it("verifyConfigForSave blocks a config whose project differs from the Admin SDK", async () => {
    process.env.FIREBASE_PROJECT_ID = "am-st-b507f";
    const { verifyConfigForSave } = await import("@/lib/firebase/probe");
    const result = await verifyConfigForSave(NOTES_CONFIG);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("ADMIN_PROJECT_MISMATCH");
  });
});
