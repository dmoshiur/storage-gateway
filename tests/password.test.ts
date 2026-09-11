import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { hashPassword, verifyPassword } from "@/lib/auth/password";

describe("first-party passwords", () => {
  it("uses a salted memory-hard hash and verifies only the matching password", () => {
    const encoded = hashPassword("correct horse battery staple");
    expect(encoded.startsWith("scrypt$")).toBe(true);
    expect(encoded).not.toContain("correct horse");
    expect(verifyPassword("correct horse battery staple", encoded)).toBe(true);
    expect(verifyPassword("wrong password", encoded)).toBe(false);
  });
});
