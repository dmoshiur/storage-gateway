import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

import { createUserSchema, updateUserSchema, loginSchema } from "@/lib/validation/schemas";
import { validationError, validationMessageFrom, fieldsFromIssues } from "@/lib/api/validation";
import { checkPasswordPolicy, PASSWORD_MIN_LENGTH } from "@/lib/auth/password-policy";

/** Runs a payload through the real create-user schema and returns the ApiError. */
function reject(payload: unknown) {
  const parsed = createUserSchema.safeParse(payload);
  expect(parsed.success).toBe(false);
  if (parsed.success) throw new Error("unreachable");
  return validationError(parsed.error.issues, "body");
}

const GENERIC = "Some information is missing or invalid.";

describe("create-user validation surfaces the real reason", () => {
  it("never returns the generic placeholder message", () => {
    const payloads: unknown[] = [
      { email: "user@example.org", role: "viewer", password: "short" },
      { email: "not-an-email", role: "viewer", password: "ValidPassword123" },
      { email: "user@example.org", role: "superuser", password: "ValidPassword123" },
      { role: "viewer", password: "ValidPassword123" },
      { email: "user@example.org", password: "ValidPassword123" },
      {},
    ];
    for (const payload of payloads) {
      const error = reject(payload);
      expect(error.message).not.toBe(GENERIC);
      expect(error.message.length).toBeGreaterThan(0);
      expect(error.status).toBe(400);
    }
  });

  it("reports a password shorter than the policy — the original bug", () => {
    const error = reject({ email: "user@example.org", role: "viewer", password: "short" });
    expect(error.message).toBe(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
    expect(error.fields?.password).toBe(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  });

  it("reports an invalid email address", () => {
    const error = reject({ email: "not-an-email", role: "viewer", password: "ValidPassword123" });
    expect(error.message).toBe("Enter a valid email address.");
    expect(error.fields?.email).toBe("Enter a valid email address.");
  });

  it("reports an invalid role and names the allowed values", () => {
    const error = reject({ email: "user@example.org", role: "superuser", password: "ValidPassword123" });
    expect(error.message).toBe("Role must be admin, editor, or viewer.");
  });

  it("reports missing required fields by name", () => {
    expect(reject({ role: "viewer", password: "ValidPassword123" }).message).toBe("Email address is required.");
    // A missing role is reported as missing; a *wrong* role lists the valid values.
    expect(reject({ email: "user@example.org", password: "ValidPassword123" }).message).toBe("Role is required.");
  });

  it("summarizes multiple problems while keeping every field detail", () => {
    const error = reject({ email: "bad", role: "nope", password: "x" });
    expect(error.message).toContain("other problems with this form");
    expect(Object.keys(error.fields ?? {}).sort()).toEqual(["email", "password", "role"]);
  });

  it("never echoes the submitted password back to the client", () => {
    const secret = "hunter2";
    const error = reject({ email: "user@example.org", role: "viewer", password: secret });
    expect(JSON.stringify({ message: error.message, fields: error.fields })).not.toContain(secret);
  });

  it("leaks no SQL, driver, or infrastructure detail", () => {
    const error = reject({ email: "bad", role: "nope", password: "x" });
    const serialized = JSON.stringify({ message: error.message, fields: error.fields });
    expect(serialized).not.toMatch(/insert|select|sqlite|libsql|turso|token|postgres|constraint/i);
  });
});

describe("create-user schema normalization", () => {
  it("accepts a valid payload for each role", () => {
    for (const role of ["admin", "editor", "viewer"] as const) {
      const parsed = createUserSchema.safeParse({ email: "user@example.org", role, password: "ValidPassword123" });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.role).toBe(role);
    }
  });

  it("lower-cases and trims the email so duplicates cannot differ by case", () => {
    const parsed = createUserSchema.safeParse({ email: "  User.Name@Example.ORG  ", role: "viewer", password: "ValidPassword123" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.email).toBe("user.name@example.org");
  });

  it("treats an empty password as omitted so a temporary one is generated", () => {
    const parsed = createUserSchema.safeParse({ email: "user@example.org", role: "viewer", password: "" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.password).toBeUndefined();
  });

  it("accepts a password exactly at the minimum length", () => {
    const parsed = createUserSchema.safeParse({
      email: "user@example.org",
      role: "viewer",
      password: "a".repeat(PASSWORD_MIN_LENGTH),
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a password one character below the minimum", () => {
    const parsed = createUserSchema.safeParse({
      email: "user@example.org",
      role: "viewer",
      password: "a".repeat(PASSWORD_MIN_LENGTH - 1),
    });
    expect(parsed.success).toBe(false);
  });
});

describe("shared password policy", () => {
  it("accepts a compliant password and rejects a short one with a specific reason", () => {
    expect(checkPasswordPolicy("ValidPassword123").ok).toBe(true);
    const short = checkPasswordPolicy("short");
    expect(short.ok).toBe(false);
    expect(short.message).toBe(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  });

  it("requires a password to be present", () => {
    expect(checkPasswordPolicy("").ok).toBe(false);
    expect(checkPasswordPolicy(undefined).ok).toBe(false);
  });

  it("matches the policy the login and update schemas rely on", () => {
    // Sign-in must not apply the minimum-length rule to existing credentials.
    expect(loginSchema.safeParse({ email: "user@example.org", password: "old" }).success).toBe(true);
    expect(updateUserSchema.safeParse({ role: "editor" }).success).toBe(true);
    expect(updateUserSchema.safeParse({}).success).toBe(false);
  });
});

describe("validation message formatting", () => {
  it("humanizes Zod's built-in strings", () => {
    const parsed = createUserSchema.safeParse({ email: "user@example.org", role: "viewer", password: 12345 });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const message = validationMessageFrom(parsed.error.issues, "body");
    expect(message).not.toMatch(/String must contain|Expected string, received/);
  });

  it("keeps the first issue per field", () => {
    const parsed = createUserSchema.safeParse({ email: "bad", role: "nope", password: "x" });
    if (parsed.success) throw new Error("expected failure");
    const fields = fieldsFromIssues(parsed.error.issues, "body");
    expect(Object.values(fields).every((value) => typeof value === "string" && value.length > 0)).toBe(true);
  });
});
