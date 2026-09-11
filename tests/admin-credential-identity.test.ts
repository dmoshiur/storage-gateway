import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { describeAdminCredentialIdentity } = await import("@/lib/firebase/admin");

/**
 * A service account from project A combined with `FIREBASE_PROJECT_ID=B` makes
 * every Firestore read fail with PERMISSION_DENIED, which presents as "the
 * files collection is broken". This is the check that names that mistake.
 */
describe("Admin credential / project identity", () => {
  beforeEach(() => {
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.FIREBASE_CLIENT_EMAIL;
  });

  afterEach(() => {
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.FIREBASE_CLIENT_EMAIL;
  });

  it("confirms a credential and project id that belong together", () => {
    process.env.FIREBASE_PROJECT_ID = "am-st-b507f";
    process.env.FIREBASE_CLIENT_EMAIL = "firebase-adminsdk-abc12@am-st-b507f.iam.gserviceaccount.com";

    expect(describeAdminCredentialIdentity()).toEqual({
      projectId: "am-st-b507f",
      credentialProjectId: "am-st-b507f",
      projectMatch: true,
    });
  });

  it("flags a credential from a different project than FIREBASE_PROJECT_ID", () => {
    process.env.FIREBASE_PROJECT_ID = "am-st-b507f";
    process.env.FIREBASE_CLIENT_EMAIL = "firebase-adminsdk-abc12@some-other-project.iam.gserviceaccount.com";

    const identity = describeAdminCredentialIdentity();
    expect(identity.projectMatch).toBe(false);
    expect(identity.credentialProjectId).toBe("some-other-project");
    expect(identity.projectId).toBe("am-st-b507f");
  });

  it("reports unknown rather than guessing for non-IAM service accounts", () => {
    process.env.FIREBASE_PROJECT_ID = "am-st-b507f";
    process.env.FIREBASE_CLIENT_EMAIL = "worker@am-st-b507f.appspot.gserviceaccount.com";

    expect(describeAdminCredentialIdentity()).toEqual({
      projectId: "am-st-b507f",
      credentialProjectId: null,
      projectMatch: null,
    });
  });

  it("reports unknown when the credential is not configured at all", () => {
    process.env.FIREBASE_PROJECT_ID = "am-st-b507f";
    expect(describeAdminCredentialIdentity().projectMatch).toBeNull();
  });
});
